import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { startTestServer, authHeaders, testConfig, testClass, type TestServer } from "./helpers.ts";
import { buildSpawnPlan } from "../src/claude/args.ts";
import { renderSeed } from "../src/claude/sessions.ts";

/**
 * The fake CLI answers "echo<N>: ..." where N counts turns inside one process,
 * so the reply number is direct evidence of whether a session was reused.
 */
describe("session reuse", () => {
  let server: TestServer;

  before(async () => {
    server = await startTestServer();
  });
  after(async () => {
    await server.close();
  });

  const say = async (messages: unknown[]) => {
    const res = await fetch(`${server.base}/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ model: "oracle", messages }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    return body.choices[0]!.message.content;
  };

  test("a follow-up turn reuses the process and sends only the new message", async () => {
    const first = await say([{ role: "user", content: "one" }]);
    assert.equal(first, "echo1: one");

    const second = await say([
      { role: "user", content: "one" },
      { role: "assistant", content: first },
      { role: "user", content: "two" },
    ]);
    // Turn 2 of the same process, and it echoes only "two": the history was
    // never resent.
    assert.equal(second, "echo2: two");

    const third = await say([
      { role: "user", content: "one" },
      { role: "assistant", content: first },
      { role: "user", content: "two" },
      { role: "assistant", content: second },
      { role: "user", content: "three" },
    ]);
    assert.equal(third, "echo3: three");
  });

  test("matching survives an assistant message the client rewrote", async () => {
    await say([{ role: "user", content: "alpha" }]);
    const reply = await say([
      { role: "user", content: "alpha" },
      { role: "assistant", content: "  something the client mangled  " },
      { role: "user", content: "beta" },
    ]);
    assert.equal(reply, "echo2: beta");
  });

  test("an unrelated conversation gets its own process", async () => {
    const reply = await say([{ role: "user", content: "totally different opener" }]);
    assert.equal(reply, "echo1: totally different opener");
  });

  test("editing an earlier user message branches to a new session", async () => {
    await say([{ role: "user", content: "branch root" }]);
    const edited = await say([
      { role: "user", content: "branch root EDITED" },
      { role: "assistant", content: "whatever" },
      { role: "user", content: "next" },
    ]);
    // The prefix no longer matches, so this is a fresh process seeded with the
    // rendered transcript.
    assert.equal(edited.startsWith("echo1:"), true);
  });

  test("admin endpoint reports live sessions", async () => {
    const res = await fetch(`${server.base}/admin/sessions`, { headers: authHeaders() });
    const body = (await res.json()) as { sessions: Array<{ turns: number; mode: string }> };
    assert.ok(body.sessions.length > 0);
    assert.ok(body.sessions.some((s) => s.turns >= 3));
    assert.ok(body.sessions.every((s) => s.mode === "oracle"));
  });
});

describe("seed rendering", () => {
  test("a lone user message is passed through untouched", () => {
    const blocks = renderSeed([{ role: "user", content: [{ type: "text", text: "just this" }] }]);
    assert.deepEqual(blocks, [{ type: "text", text: "just this" }]);
  });

  test("prior history is rendered as a transcript", () => {
    const blocks = renderSeed([
      { role: "user", content: [{ type: "text", text: "first" }] },
      { role: "assistant", content: [{ type: "text", text: "reply" }] },
      { role: "user", content: [{ type: "text", text: "second" }] },
    ]);
    assert.equal(blocks.length, 1);
    const text = (blocks[0] as { text: string }).text;
    assert.match(text, /<conversation_so_far>/);
    assert.match(text, /<turn role="assistant">\nreply\n<\/turn>/);
    assert.match(text, /<current_message>\nsecond\n<\/current_message>/);
  });
});

describe("CLI argument construction", () => {
  const cfg = testConfig();

  test("oracle mode strips the agent down to a completion endpoint", () => {
    const plan = buildSpawnPlan(cfg, testClass({ systemPrompt: "be terse" }));
    const args = plan.args;
    assert.ok(args.includes("--print"));
    assert.ok(args.includes("--include-partial-messages"));
    assert.equal(args[args.indexOf("--tools") + 1], "");
    assert.ok(args.includes("--strict-mcp-config"));
    assert.ok(args.includes("--disable-slash-commands"));
    assert.equal(args[args.indexOf("--setting-sources") + 1], "");
    assert.ok(!args.includes("--permission-mode"));
    assert.equal(plan.env["DISABLE_NON_ESSENTIAL_MODEL_CALLS"], "1");

    // The system prompt travels by file, never on the command line.
    const promptFile = args[args.indexOf("--system-prompt-file") + 1]!;
    assert.equal(readFileSync(promptFile, "utf8"), "be terse");
  });

  test("harness mode keeps Claude Code intact and appends the client prompt", () => {
    const plan = buildSpawnPlan(
      cfg,
      testClass({
        mode: "harness",
        model: "claude-opus-5",
        systemPrompt: "extra rules",
        effort: "high",
        cwd: mkdtempSync(join(tmpdir(), "socket-cwd-")),
      }),
    );
    const args = plan.args;
    assert.ok(!args.includes("--system-prompt-file"));
    assert.ok(args.includes("--append-system-prompt-file"));
    assert.equal(args[args.indexOf("--permission-mode") + 1], "acceptEdits");
    assert.ok(!args.includes("--dangerously-skip-permissions"));
    assert.ok(args.includes("--exclude-dynamic-system-prompt-sections"));
    assert.equal(args[args.indexOf("--effort") + 1], "high");
  });

  test("a base URL pointing back at this server is stripped from the child", () => {
    // Without this the spawned CLI would call the socket, which would spawn
    // another CLI, without end.
    const previous = process.env["ANTHROPIC_BASE_URL"];
    process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${cfg.server.port}/v1`;
    try {
      const plan = buildSpawnPlan(cfg, testClass());
      assert.ok(plan.unsetEnv.includes("ANTHROPIC_BASE_URL"));
    } finally {
      if (previous === undefined) delete process.env["ANTHROPIC_BASE_URL"];
      else process.env["ANTHROPIC_BASE_URL"] = previous;
    }
  });

  test("an unrelated base URL is left alone", () => {
    const previous = process.env["ANTHROPIC_BASE_URL"];
    process.env["ANTHROPIC_BASE_URL"] = "https://gateway.corp.example.com";
    try {
      const plan = buildSpawnPlan(cfg, testClass());
      assert.deepEqual(plan.unsetEnv, []);
    } finally {
      if (previous === undefined) delete process.env["ANTHROPIC_BASE_URL"];
      else process.env["ANTHROPIC_BASE_URL"] = previous;
    }
  });

  test("a JSON schema is forwarded to the CLI", () => {
    const schema = { type: "object", properties: { name: { type: "string" } } };
    const plan = buildSpawnPlan(cfg, testClass({ jsonSchema: JSON.stringify(schema) }));
    assert.deepEqual(JSON.parse(plan.args[plan.args.indexOf("--json-schema") + 1]!), schema);
  });
});
