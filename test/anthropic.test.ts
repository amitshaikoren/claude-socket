import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, authHeaders, type TestServer } from "./helpers.ts";

describe("Anthropic dialect", () => {
  let server: TestServer;

  before(async () => {
    server = await startTestServer();
  });
  after(async () => {
    await server.close();
  });

  const post = (body: unknown, path = "/v1/messages") =>
    fetch(`${server.base}${path}`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
    });

  test("accepts x-api-key as well as bearer auth", async () => {
    const res = await fetch(`${server.base}/v1/models`, {
      headers: { "x-api-key": "test-token" },
    });
    assert.equal(res.status, 200);
  });

  test("answers a non-streaming message in Anthropic shape", async () => {
    const res = await post({
      model: "claude-sonnet-5",
      max_tokens: 256,
      system: "be brief",
      messages: [{ role: "user", content: "hello there" }],
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      type: string;
      role: string;
      content: Array<{ type: string; text: string }>;
      stop_reason: string;
      usage: { input_tokens: number; output_tokens: number };
    };
    assert.equal(body.type, "message");
    assert.equal(body.role, "assistant");
    assert.equal(body.content[0]!.type, "text");
    assert.equal(body.content[0]!.text, "echo1: hello there");
    assert.equal(body.stop_reason, "end_turn");
    assert.equal(body.usage.output_tokens, 5);
  });

  test("streams exactly one well-formed message envelope", async () => {
    const res = await post({
      model: "claude-sonnet-5",
      max_tokens: 256,
      messages: [{ role: "user", content: "stream this" }],
      stream: true,
    });
    assert.equal(res.status, 200);

    const raw = await res.text();
    const events = raw
      .split("\n")
      .filter((l) => l.startsWith("event: "))
      .map((l) => l.slice(7));

    assert.equal(events[0], "message_start");
    assert.equal(events[1], "content_block_start");
    assert.equal(events.at(-1), "message_stop");
    assert.equal(events.at(-2), "message_delta");
    assert.equal(events.at(-3), "content_block_stop");
    assert.equal(events.filter((e) => e === "message_start").length, 1);
    assert.equal(events.filter((e) => e === "message_stop").length, 1);

    const text = raw
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)) as Record<string, any>)
      .filter((d) => d.type === "content_block_delta")
      .map((d) => d.delta.text)
      .join("");
    assert.equal(text, "echo1: stream this");
  });

  test("errors use the Anthropic error envelope", async () => {
    const res = await post({ model: "claude-sonnet-5", messages: [] });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { type: string; error: { type: string } };
    assert.equal(body.type, "error");
    assert.equal(body.error.type, "invalid_request_error");
  });

  test("estimates token counts", async () => {
    const res = await post(
      { model: "claude-sonnet-5", messages: [{ role: "user", content: "x".repeat(380) }] },
      "/v1/messages/count_tokens",
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { input_tokens: number };
    assert.equal(body.input_tokens, 100);
  });

  test("health needs no credentials", async () => {
    const res = await fetch(`${server.base}/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; service: string };
    assert.equal(body.status, "ok");
    assert.equal(body.service, "claude-bridge");
  });
});
