import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, testConfig, authHeaders, readSse, type TestServer } from "./helpers.ts";

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

/**
 * A streamed reply and a non-streamed one are the same turn rendered two ways.
 * Any string a client can reassemble from the deltas has to match what the
 * non-streaming path would have returned — these are the two ways that failed.
 */
describe("OpenAI streaming matches non-streaming", () => {
  let server: TestServer;

  before(async () => {
    server = await startTestServer();
  });
  after(async () => server.close());

  const post = (body: unknown) =>
    fetch(`${server.base}/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
    });

  const NOOP_TOOL = {
    type: "function",
    function: { name: "noop", description: "does nothing", parameters: { type: "object", properties: {} } },
  };

  async function streamedText(body: Record<string, unknown>): Promise<string> {
    const res = await post({ ...body, stream: true });
    assert.equal(res.status, 200);
    const payloads = await readSse(res);
    return payloads
      .slice(0, -1)
      .map((p) => JSON.parse(p) as Record<string, any>)
      .filter((c) => c.choices?.[0]?.delta?.content)
      .map((c) => c.choices[0].delta.content as string)
      .join("");
  }

  test("keeps a trailing character that could have started a tool_call tag", async () => {
    // "<" is a one-character prefix of "<tool_call>", so the scanner holds it
    // back. Without a flush at end of stream it is never released.
    const text = await streamedText({
      model: "oracle",
      messages: [{ role: "user", content: "AB<" }],
      tools: [NOOP_TOOL],
    });
    assert.match(text, /: AB<$/, "the held tail reached the client");
  });

  test("restores the blank line between two text blocks", async () => {
    const cfg = testConfig();
    cfg.claude.env = { FAKE_TEXT_BLOCKS: "2" };
    const blocks = await startTestServer(cfg);
    try {
      const body = { model: "oracle", messages: [{ role: "user", content: "hi" }] };
      const send = (b: unknown) =>
        fetch(`${blocks.base}/v1/chat/completions`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify(b),
        });

      const plain = (await (await send(body)).json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      const whole = plain.choices[0]!.message.content;
      assert.equal(whole, "block one\n\nblock two: hi");

      const payloads = await readSse(await send({ ...body, stream: true }));
      const streamed = payloads
        .slice(0, -1)
        .map((p) => JSON.parse(p) as Record<string, any>)
        .filter((c) => c.choices?.[0]?.delta?.content)
        .map((c) => c.choices[0].delta.content as string)
        .join("");
      assert.equal(streamed, whole, "the delta stream dropped the block separator");
    } finally {
      await blocks.close();
    }
  });
});

/**
 * The delta stream is an alignment with `done.text`, not a proof of equality.
 * A client that grounds on the reply can ask for the string the bridge itself
 * treats as authoritative, rather than reassembling one and hoping.
 */
describe("OpenAI authoritative text trailer", () => {
  let server: TestServer;

  before(async () => {
    server = await startTestServer();
  });
  after(async () => server.close());

  const stream = (body: unknown, headers = authHeaders()) =>
    fetch(`${server.base}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

  const trailer = async (res: Response): Promise<string | undefined> => {
    const payloads = await readSse(res);
    const frame = payloads
      .slice(0, -1)
      .map((p) => JSON.parse(p) as Record<string, any>)
      .find((c) => c.claude_bridge);
    return frame?.claude_bridge?.text as string | undefined;
  };

  const body = {
    model: "oracle",
    messages: [{ role: "user", content: "ground me" }],
    stream: true,
  };

  test("is absent unless asked for", async () => {
    assert.equal(await trailer(await stream(body)), undefined);
  });

  test("stream_options opts in", async () => {
    const res = await stream({ ...body, stream_options: { include_authoritative_text: true } });
    assert.match((await trailer(res)) ?? "", /: ground me$/);
  });

  test("the header opts in too, for clients that cannot set stream_options", async () => {
    const res = await stream(body, {
      ...authHeaders(),
      "x-claude-authoritative-text": "1",
    });
    assert.match((await trailer(res)) ?? "", /: ground me$/);
  });
});

/**
 * Call-shaped markup that does not parse is consumed out of the prose and yields
 * no call, which from the client's side is indistinguishable from the model
 * simply answering. These assert the one thing that distinguishes it, at the
 * layer a client actually sees — the HTTP response, not the scanner.
 */
describe("unparseable tool-call markup is surfaced", () => {
  let server: TestServer;

  before(async () => {
    server = await startTestServer();
  });
  after(async () => {
    await server.close();
  });

  const TOOL = {
    type: "function",
    function: { name: "noop", description: "does nothing", parameters: { type: "object", properties: {} } },
  };

  // The fake CLI echoes the prompt, so this comes back inside the reply.
  const BAD = "<tool_call>{not json}</tool_call>";

  const post = (body: unknown) =>
    fetch(`${server.base}/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
    });

  test("a non-streamed reply carries the count", async () => {
    const res = await post({
      model: "oracle",
      messages: [{ role: "user", content: BAD }],
      tools: [TOOL],
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      claude_bridge?: { unparsed_tool_calls?: number };
      choices: Array<{ message: { tool_calls?: unknown } }>;
    };
    assert.equal(body.claude_bridge?.unparsed_tool_calls, 1);
    assert.equal(body.choices[0]!.message.tool_calls, undefined);
  });

  test("a streamed reply carries it on the terminal frame, unasked", async () => {
    const res = await post({
      model: "oracle",
      messages: [{ role: "user", content: BAD }],
      tools: [TOOL],
      stream: true,
    });
    const frames = (await readSse(res))
      .slice(0, -1)
      .map((p) => JSON.parse(p) as Record<string, any>);
    const trailer = frames.find((f) => f.claude_bridge);
    assert.equal(trailer?.claude_bridge?.unparsed_tool_calls, 1);
    // Opting out of the authoritative text must not opt out of the diagnostic.
    assert.equal(trailer?.claude_bridge?.text, undefined);
  });

  test("a clean turn says nothing", async () => {
    const res = await post({
      model: "oracle",
      messages: [{ role: "user", content: "nothing odd here" }],
      tools: [TOOL],
    });
    const body = (await res.json()) as { claude_bridge?: unknown };
    assert.equal(body.claude_bridge, undefined);
  });

  test("markup is left alone when the request declared no tools", async () => {
    // Nothing is scanning, so the text passes through and there is nothing to
    // report — a conversation about the protocol is not a protocol failure.
    const res = await post({ model: "oracle", messages: [{ role: "user", content: BAD }] });
    const body = (await res.json()) as {
      claude_bridge?: unknown;
      choices: Array<{ message: { content: string } }>;
    };
    assert.equal(body.claude_bridge, undefined);
    assert.match(body.choices[0]!.message.content, /<tool_call>/);
  });
});

describe("the harness's own tool count is on the wire", () => {
  test("a turn that ran tools reports how many, without opening the database", async () => {
    const cfg = testConfig();
    cfg.claude.env = { FAKE_TOOL_USE: "1" };
    const server = await startTestServer(cfg);
    try {
      const res = await fetch(`${server.base}/v1/chat/completions`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ model: "harness", messages: [{ role: "user", content: "read it" }] }),
      });
      const body = (await res.json()) as {
        usage: { tool_call_count: number; step_usage: Array<{ tools: string[] }> };
      };
      assert.ok(body.usage.tool_call_count > 0, "the harness ran tools and said so");
      // The scalar must agree with the per-step breakdown it summarizes.
      const summed = body.usage.step_usage.reduce((a, s) => a + s.tools.length, 0);
      assert.equal(body.usage.tool_call_count, summed);
    } finally {
      await server.close();
    }
  });

  test("a turn that ran none reports zero, not a missing field", async () => {
    const server = await startTestServer();
    try {
      const res = await fetch(`${server.base}/v1/chat/completions`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ model: "oracle", messages: [{ role: "user", content: "hi" }] }),
      });
      const body = (await res.json()) as { usage: { tool_call_count: number } };
      assert.equal(body.usage.tool_call_count, 0);
    } finally {
      await server.close();
    }
  });
});
