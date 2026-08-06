import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, authHeaders, readSse, type TestServer } from "./helpers.ts";

describe("OpenAI dialect", () => {
  let server: TestServer;

  before(async () => {
    server = await startTestServer();
  });
  after(async () => {
    await server.close();
  });

  const post = (body: unknown, headers = authHeaders()) =>
    fetch(`${server.base}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

  test("rejects a request with no token", async () => {
    const res = await fetch(`${server.base}/v1/models`);
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error: { type: string } };
    assert.equal(body.error.type, "authentication_error");
  });

  test("rejects a request with the wrong token", async () => {
    const res = await post({ messages: [{ role: "user", content: "hi" }] }, authHeaders("nope"));
    assert.equal(res.status, 401);
  });

  test("advertises a model catalog", async () => {
    const res = await fetch(`${server.base}/v1/models`, { headers: authHeaders() });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: Array<{ id: string; mode: string }> };
    const ids = body.data.map((m) => m.id);
    assert.ok(ids.includes("oracle"));
    assert.ok(ids.includes("harness"));
    assert.ok(ids.includes("claude-sonnet-5-harness"));
    assert.equal(body.data.find((m) => m.id === "claude-sonnet-5")?.mode, "oracle");
  });

  test("answers a non-streaming completion in OpenAI shape", async () => {
    const res = await post({
      model: "oracle",
      messages: [{ role: "user", content: "hello" }],
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      object: string;
      model: string;
      choices: Array<{ message: { role: string; content: string }; finish_reason: string }>;
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };
    assert.equal(body.object, "chat.completion");
    assert.equal(body.model, "oracle");
    assert.equal(body.choices[0]!.message.role, "assistant");
    assert.equal(body.choices[0]!.message.content, "echo1: hello");
    assert.equal(body.choices[0]!.finish_reason, "stop");
    assert.equal(body.usage.completion_tokens, 5);
    assert.equal(body.usage.total_tokens, body.usage.prompt_tokens + 5);
  });

  test("streams chunks and terminates with [DONE]", async () => {
    const res = await post({
      model: "oracle",
      messages: [{ role: "user", content: "stream me" }],
      stream: true,
      stream_options: { include_usage: true },
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);

    const payloads = await readSse(res);
    assert.equal(payloads.at(-1), "[DONE]");

    const chunks = payloads.slice(0, -1).map((p) => JSON.parse(p) as Record<string, any>);
    assert.equal(chunks[0]!.choices[0].delta.role, "assistant");

    const text = chunks
      .filter((c) => c.choices?.[0]?.delta?.content)
      .map((c) => c.choices[0].delta.content)
      .join("");
    assert.equal(text, "echo1: stream me");

    const finish = chunks.find((c) => c.choices?.[0]?.finish_reason);
    assert.equal(finish?.choices[0].finish_reason, "stop");

    const usage = chunks.find((c) => c.usage);
    assert.ok(usage!.usage.total_tokens > 0);
    assert.equal(usage!.choices.length, 0);
  });

  test("system messages are accepted and shape the session", async () => {
    const res = await post({
      model: "oracle",
      messages: [
        { role: "system", content: "You are a pirate." },
        { role: "user", content: "ahoy" },
      ],
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    // A distinct system prompt is a distinct session class, so this is turn 1.
    assert.equal(body.choices[0]!.message.content, "echo1: ahoy");
  });

  test("rejects a conversation that does not end with a user message", async () => {
    const res = await post({
      model: "oracle",
      messages: [{ role: "assistant", content: "I spoke last" }],
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { message: string } };
    assert.match(body.error.message, /final message must be from the user/);
  });

  test("unknown routes 404 in OpenAI error shape", async () => {
    const res = await fetch(`${server.base}/v1/embeddings`, {
      method: "POST",
      headers: authHeaders(),
      body: "{}",
    });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: { type: string } };
    assert.equal(body.error.type, "not_found_error");
  });
});
