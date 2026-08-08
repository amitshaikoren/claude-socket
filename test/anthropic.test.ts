import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, testConfig, authHeaders, type TestServer } from "./helpers.ts";

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

/**
 * The mirror of the OpenAI parity suite: the same turn streamed and not
 * streamed has to yield the same text. Both handlers reassemble independently,
 * so both need the invariant pinned.
 */
describe("Anthropic streaming matches non-streaming", () => {
  let server: TestServer;

  before(async () => {
    server = await startTestServer();
  });
  after(async () => server.close());

  const NOOP_TOOL = { name: "noop", description: "does nothing", input_schema: { type: "object", properties: {} } };

  const send = (base: string, body: unknown) =>
    fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
    });

  /** Concatenate the text_delta payloads, as a streaming client would. */
  async function streamedText(res: Response): Promise<string> {
    assert.equal(res.status, 200);
    return (await res.text())
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)) as Record<string, any>)
      .filter((d) => d.type === "content_block_delta" && d.delta?.type === "text_delta")
      .map((d) => d.delta.text as string)
      .join("");
  }

  test("keeps a trailing character that could have started a tool_call tag", async () => {
    const text = await streamedText(
      await send(server.base, {
        model: "claude-sonnet-5",
        max_tokens: 256,
        messages: [{ role: "user", content: "AB<" }],
        tools: [NOOP_TOOL],
        stream: true,
      }),
    );
    assert.match(text, /: AB<$/, "the held tail reached the client");
  });

  test("restores the blank line between two text blocks", async () => {
    const cfg = testConfig();
    cfg.claude.env = { FAKE_TEXT_BLOCKS: "2" };
    const blocks = await startTestServer(cfg);
    try {
      const body = {
        model: "claude-sonnet-5",
        max_tokens: 256,
        messages: [{ role: "user", content: "hi" }],
      };

      const plain = (await (await send(blocks.base, body)).json()) as {
        content: Array<{ type: string; text: string }>;
      };
      const whole = plain.content[0]!.text;
      assert.equal(whole, "block one\n\nblock two: hi");

      const streamed = await streamedText(await send(blocks.base, { ...body, stream: true }));
      assert.equal(streamed, whole, "the delta stream dropped the block separator");
    } finally {
      await blocks.close();
    }
  });
});

describe("Anthropic authoritative text trailer", () => {
  let server: TestServer;

  before(async () => {
    server = await startTestServer();
  });
  after(async () => server.close());

  const body = {
    model: "claude-sonnet-5",
    max_tokens: 256,
    messages: [{ role: "user", content: "ground me" }],
    stream: true,
  };

  /** The authoritative string rides on message_delta, beside the usage payload. */
  async function trailer(headers: Record<string, string>): Promise<string | undefined> {
    const res = await fetch(`${server.base}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 200);
    const frame = (await res.text())
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)) as Record<string, any>)
      .find((d) => d.type === "message_delta");
    return frame?.claude_bridge?.text as string | undefined;
  }

  test("is absent unless asked for", async () => {
    assert.equal(await trailer(authHeaders()), undefined);
  });

  test("the header opts in", async () => {
    const text = await trailer({ ...authHeaders(), "x-claude-authoritative-text": "1" });
    assert.match(text ?? "", /: ground me$/);
  });
});
