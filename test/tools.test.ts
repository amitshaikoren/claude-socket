import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  ToolCallScanner,
  buildToolPrompt,
  extractToolCalls,
  parseAnthropicTools,
  parseOpenAiToolChoice,
  parseOpenAiTools,
} from "../src/core/tools.ts";
import { startTestServer, authHeaders, testConfig, type TestServer } from "./helpers.ts";

const WEATHER = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Look up the weather",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  },
};

describe("tool definition parsing", () => {
  test("reads OpenAI tools", () => {
    const tools = parseOpenAiTools([WEATHER]);
    assert.equal(tools.length, 1);
    assert.equal(tools[0]!.name, "get_weather");
    assert.equal(tools[0]!.description, "Look up the weather");
  });

  test("reads Anthropic tools", () => {
    const tools = parseAnthropicTools([
      { name: "get_weather", description: "d", input_schema: { type: "object" } },
    ]);
    assert.equal(tools[0]!.name, "get_weather");
    assert.deepEqual(tools[0]!.parameters, { type: "object" });
  });

  test("tool_choice variants", () => {
    assert.equal(parseOpenAiToolChoice(undefined).kind, "auto");
    assert.equal(parseOpenAiToolChoice("none").kind, "none");
    assert.equal(parseOpenAiToolChoice("required").kind, "required");
    const named = parseOpenAiToolChoice({ type: "function", function: { name: "x" } });
    assert.equal(named.kind, "named");
    assert.equal(named.kind === "named" && named.name, "x");
  });

  test("tool_choice none suppresses the protocol entirely", () => {
    assert.equal(buildToolPrompt(parseOpenAiTools([WEATHER]), { kind: "none" }), "");
    assert.equal(buildToolPrompt([], { kind: "auto" }), "");
  });

  test("the prompt carries the catalog and the mandate", () => {
    const prompt = buildToolPrompt(parseOpenAiTools([WEATHER]), { kind: "required" });
    assert.match(prompt, /get_weather/);
    assert.match(prompt, /<tool_call>/);
    assert.match(prompt, /MUST call at least one tool/);
  });
});

describe("tool call extraction", () => {
  test("pulls calls out and leaves the prose", () => {
    const { text, calls } = extractToolCalls(
      'Let me check.\n<tool_call>{"name": "get_weather", "arguments": {"city": "Oslo"}}</tool_call>',
    );
    assert.equal(text, "Let me check.");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.name, "get_weather");
    assert.deepEqual(JSON.parse(calls[0]!.argumentsJson), { city: "Oslo" });
    assert.match(calls[0]!.id, /^call_/);
  });

  test("handles several calls in one reply", () => {
    const { calls } = extractToolCalls(
      '<tool_call>{"name":"a","arguments":{}}</tool_call><tool_call>{"name":"b","arguments":{"x":1}}</tool_call>',
    );
    assert.deepEqual(calls.map((c) => c.name), ["a", "b"]);
  });

  test("a reply with no tags is untouched", () => {
    const { text, calls } = extractToolCalls("Just a normal answer.");
    assert.equal(text, "Just a normal answer.");
    assert.equal(calls.length, 0);
  });

  test("malformed JSON yields no call, and says so", () => {
    const { calls, unparsed } = extractToolCalls("<tool_call>{not json}</tool_call>");
    assert.equal(calls.length, 0);
    // The region is gone from the prose either way. Emitting a broken call is
    // worse than dropping it, but a client that cannot tell the difference
    // between this and a plain answer has no way to diagnose the protocol.
    assert.equal(unparsed, 1);
  });

  test("valid JSON that is not a call shape also counts as unparsed", () => {
    const { calls, unparsed } = extractToolCalls('<tool_call>{"nome":"a"}</tool_call>');
    assert.equal(calls.length, 0);
    assert.equal(unparsed, 1);
  });

  test("an unterminated call is still recovered", () => {
    const { calls, unparsed } = extractToolCalls('text <tool_call>{"name":"a","arguments":{}}');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.name, "a");
    assert.equal(unparsed, 0);
  });

  test("an unterminated call that does not parse takes the rest of the reply with it", () => {
    // The worst version of the failure: the reply reads as complete and is not.
    const { text, calls, unparsed } = extractToolCalls("The answer is <tool_call>{oops");
    assert.equal(text, "The answer is");
    assert.equal(calls.length, 0);
    assert.equal(unparsed, 1);
  });

  test("a clean reply reports nothing unparsed", () => {
    const clean = extractToolCalls('hi <tool_call>{"name":"a","arguments":{}}</tool_call>');
    assert.equal(clean.unparsed, 0);
    assert.equal(extractToolCalls("no tags here").unparsed, 0);
  });

  test("each bad region is counted separately", () => {
    const { calls, unparsed } = extractToolCalls(
      '<tool_call>{bad}</tool_call><tool_call>{"name":"ok","arguments":{}}</tool_call><tool_call>{worse}</tool_call>',
    );
    assert.deepEqual(calls.map((c) => c.name), ["ok"]);
    assert.equal(unparsed, 2);
  });
});

describe("streaming scanner", () => {
  /** Feed a reply one character at a time — the worst case for tag detection. */
  function streamChars(input: string) {
    const scanner = new ToolCallScanner();
    let emitted = "";
    for (const char of input) emitted += scanner.push(char);
    const tail = scanner.finish();
    return { emitted: emitted + tail.text, calls: tail.calls };
  }

  test("never leaks a partial tag, even one character at a time", () => {
    const { emitted, calls } = streamChars(
      'Checking now.<tool_call>{"name":"get_weather","arguments":{"city":"Oslo"}}</tool_call>',
    );
    assert.equal(emitted, "Checking now.");
    assert.equal(calls.length, 1);
    assert.ok(!emitted.includes("<"), "no tag fragment reached the client");
  });

  test("text after a call still flows", () => {
    const { emitted, calls } = streamChars('a<tool_call>{"name":"t","arguments":{}}</tool_call>b');
    assert.equal(emitted, "ab");
    assert.equal(calls.length, 1);
  });

  test("angle brackets that are not tags pass through", () => {
    const { emitted, calls } = streamChars("use <div> and 3 < 4 and <tool> too");
    assert.equal(emitted, "use <div> and 3 < 4 and <tool> too");
    assert.equal(calls.length, 0);
  });
});

describe("tool calling over HTTP", () => {
  let server: TestServer;

  before(async () => {
    // The fake CLI echoes the prompt back, so a prompt containing a tool-call
    // tag comes back as a tool call: an end-to-end check of the round trip.
    const cfg = testConfig();
    server = await startTestServer(cfg);
  });
  after(async () => {
    await server.close();
  });

  const chat = (body: Record<string, unknown>) =>
    fetch(`${server.base}/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
    });

  test("a tagged reply becomes an OpenAI tool_calls response", async () => {
    const res = await chat({
      model: "oracle",
      tools: [WEATHER],
      messages: [
        {
          role: "user",
          content: '<tool_call>{"name": "get_weather", "arguments": {"city": "Oslo"}}</tool_call>',
        },
      ],
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    const choice = body.choices[0];
    assert.equal(choice.finish_reason, "tool_calls");
    assert.equal(choice.message.tool_calls.length, 1);
    assert.equal(choice.message.tool_calls[0].function.name, "get_weather");
    assert.deepEqual(JSON.parse(choice.message.tool_calls[0].function.arguments), { city: "Oslo" });
    // The echoed prefix survives as content; the tag itself does not.
    assert.ok(!String(choice.message.content ?? "").includes("<tool_call>"));
  });

  test("a tool result continues the same session", async () => {
    const first = await chat({
      model: "oracle",
      tools: [WEATHER],
      messages: [{ role: "user", content: "what is the weather in Oslo" }],
    });
    const firstBody = (await first.json()) as any;
    assert.equal(firstBody.choices[0].finish_reason, "stop");

    const second = await chat({
      model: "oracle",
      tools: [WEATHER],
      messages: [
        { role: "user", content: "what is the weather in Oslo" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Oslo"}' } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "4C and raining" },
      ],
    });
    assert.equal(second.status, 200);
    const secondBody = (await second.json()) as any;
    // Turn 2 of the same process: the tool result extended the live session
    // instead of starting a new one.
    assert.match(secondBody.choices[0].message.content, /^echo2:/);
    assert.match(secondBody.choices[0].message.content, /4C and raining/);
  });

  test("tools change the session class", async () => {
    const withTools = await chat({
      model: "oracle",
      tools: [WEATHER],
      messages: [{ role: "user", content: "distinct opener for tool class" }],
    });
    const withoutTools = await chat({
      model: "oracle",
      messages: [{ role: "user", content: "distinct opener for tool class" }],
    });
    // Same text, different system prompt, so neither may reuse the other.
    assert.match(((await withTools.json()) as any).choices[0].message.content, /^echo1:/);
    assert.match(((await withoutTools.json()) as any).choices[0].message.content, /^echo1:/);
  });

  test("streaming emits tool_calls then a tool_calls finish reason", async () => {
    const res = await chat({
      model: "oracle",
      stream: true,
      tools: [WEATHER],
      messages: [
        { role: "user", content: '<tool_call>{"name":"get_weather","arguments":{"city":"Rome"}}</tool_call>' },
      ],
    });
    const raw = await res.text();
    const chunks = raw
      .split("\n")
      .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
      .map((l) => JSON.parse(l.slice(6)) as any);

    const call = chunks.find((c) => c.choices?.[0]?.delta?.tool_calls);
    assert.ok(call, "a tool_calls delta was emitted");
    assert.equal(call.choices[0].delta.tool_calls[0].function.name, "get_weather");

    const finish = chunks.find((c) => c.choices?.[0]?.finish_reason);
    assert.equal(finish.choices[0].finish_reason, "tool_calls");

    const streamed = chunks
      .map((c) => c.choices?.[0]?.delta?.content ?? "")
      .join("");
    assert.ok(!streamed.includes("<tool_call>"), "no tag fragment was streamed");
  });

  test("Anthropic dialect returns tool_use blocks", async () => {
    const res = await fetch(`${server.base}/v1/messages`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 128,
        tools: [{ name: "get_weather", description: "d", input_schema: { type: "object" } }],
        messages: [
          { role: "user", content: '<tool_call>{"name":"get_weather","arguments":{"city":"Kyiv"}}</tool_call>' },
        ],
      }),
    });
    const body = (await res.json()) as any;
    assert.equal(body.stop_reason, "tool_use");
    const use = body.content.find((b: any) => b.type === "tool_use");
    assert.equal(use.name, "get_weather");
    assert.deepEqual(use.input, { city: "Kyiv" });
  });
});
