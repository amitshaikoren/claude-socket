import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, authHeaders, testConfig, testClass, type TestServer } from "./helpers.ts";
import { buildSpawnPlan } from "../src/claude/args.ts";
import { resolveTarget } from "../src/core/resolve.ts";
import { READ_ONLY_TOOLS } from "../src/core/config.ts";
import { BridgeError } from "../src/core/types.ts";

/** `--tools` as the CLI would receive it, or null when the flag is absent. */
function toolsFlag(args: string[]): string | null {
  const i = args.indexOf("--tools");
  return i < 0 ? null : args[i + 1]!;
}

describe("semi mode spawn plan", () => {
  const cfg = testConfig();

  test("semi passes the session's tool list to the CLI", () => {
    const plan = buildSpawnPlan(
      cfg,
      testClass({
        mode: "semi",
        systemPrompt: "extra rules",
        cwd: cfg.semi.workspaceRoot,
        tools: { tools: ["Read", "Grep"], allowed: [], disallowed: [] },
      }),
    );
    assert.equal(toolsFlag(plan.args), "Read,Grep");
    // Still the agent: the client's prompt is appended to Claude Code's own
    // rather than replacing it, exactly as in harness.
    assert.ok(plan.args.includes("--append-system-prompt-file"));
    assert.ok(!plan.args.includes("--system-prompt-file"));
    assert.ok(plan.args.includes("--exclude-dynamic-system-prompt-sections"));
  });

  test("harness with no configured tool list leaves the CLI's default set alone", () => {
    const plan = buildSpawnPlan(
      cfg,
      testClass({ mode: "harness", cwd: cfg.harness.workspaceRoot }),
    );
    assert.equal(toolsFlag(plan.args), null);
  });

  test("oracle still disables tools outright", () => {
    const plan = buildSpawnPlan(cfg, testClass({ mode: "oracle" }));
    assert.equal(toolsFlag(plan.args), "");
  });

  test("disallowed tools reach the CLI", () => {
    const plan = buildSpawnPlan(
      cfg,
      testClass({
        mode: "semi",
        cwd: cfg.semi.workspaceRoot,
        tools: { tools: ["Read"], allowed: [], disallowed: ["Bash"] },
      }),
    );
    assert.equal(plan.args[plan.args.indexOf("--disallowed-tools") + 1], "Bash");
  });
});

describe("tool policy resolution", () => {
  const cfg = testConfig();
  const resolve = (headers: Record<string, string>, model?: string) =>
    resolveTarget(cfg, headers, model, "", null, "");

  test("semi defaults to the configured read-only set", () => {
    const target = resolve({}, "claude-sonnet-5-semi");
    assert.equal(target.cls.mode, "semi");
    assert.deepEqual(target.cls.tools.tools, [...READ_ONLY_TOOLS].sort());
  });

  test("a request may narrow the set it was offered", () => {
    const target = resolve({ "x-claude-tools": "Read,Grep" }, "claude-sonnet-5-semi");
    assert.deepEqual(target.cls.tools.tools, ["Grep", "Read"]);
  });

  test("a request may not widen it", () => {
    // The whole point of semi is that the ceiling is the operator's to set. If a
    // header could add Bash, any client could promote itself to a full agent.
    const target = resolve({ "x-claude-tools": "Read,Bash" }, "claude-sonnet-5-semi");
    assert.deepEqual(target.cls.tools.tools, ["Read"]);
  });

  test("asking for nothing available is an error, not a silent empty agent", () => {
    assert.throws(
      () => resolve({ "x-claude-tools": "Bash,Write" }, "claude-sonnet-5-semi"),
      (err: unknown) => err instanceof BridgeError && err.status === 400,
    );
  });

  test("the header can be switched off entirely", () => {
    const locked = testConfig();
    locked.semi.allowRequestTools = false;
    const target = resolveTarget(
      locked,
      { "x-claude-tools": "Read" },
      "claude-sonnet-5-semi",
      "",
      null,
      "",
    );
    assert.deepEqual(target.cls.tools.tools, [...READ_ONLY_TOOLS].sort());
  });

  test("tool order does not fork the session class", () => {
    const a = resolve({ "x-claude-tools": "Read,Grep" }, "claude-sonnet-5-semi");
    const b = resolve({ "x-claude-tools": "Grep,Read" }, "claude-sonnet-5-semi");
    assert.deepEqual(a.cls.tools, b.cls.tools);
  });

  test("a catalog entry's tool set overrides the mode default", () => {
    const custom = testConfig();
    custom.models = [
      {
        id: "reader",
        model: "claude-sonnet-5",
        mode: "semi",
        effort: null,
        contextWindow: 200_000,
        ownedBy: "local",
        tools: ["Read"],
      },
    ];
    const target = resolveTarget(custom, {}, "reader", "", null, "");
    assert.deepEqual(target.cls.tools.tools, ["Read"]);
  });

  test("X-Claude-Mode selects semi over the model's own mode", () => {
    const target = resolve({ "x-claude-mode": "semi" }, "claude-sonnet-5");
    assert.equal(target.cls.mode, "semi");
    assert.deepEqual(target.cls.tools.tools, [...READ_ONLY_TOOLS].sort());
  });
});

describe("semi mode over HTTP", () => {
  let server: TestServer;

  before(async () => {
    server = await startTestServer();
  });
  after(async () => server.close());

  const chat = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    fetch(`${server.base}/v1/chat/completions`, {
      method: "POST",
      headers: { ...authHeaders(), ...headers },
      body: JSON.stringify(body),
    });

  test("the catalog advertises all three modes with their tool sets", async () => {
    const res = await fetch(`${server.base}/v1/models`, { headers: authHeaders() });
    const body = (await res.json()) as {
      data: Array<{ id: string; mode: string; tools: string[] | null }>;
    };

    const modes = new Set(body.data.map((m) => m.mode));
    assert.deepEqual([...modes].sort(), ["harness", "oracle", "semi"]);

    const semi = body.data.find((m) => m.id === "claude-sonnet-5-semi");
    assert.equal(semi?.mode, "semi");
    assert.deepEqual(semi?.tools, READ_ONLY_TOOLS);

    // Harness advertises null: the CLI's own default set, whatever that is.
    assert.equal(body.data.find((m) => m.id === "claude-sonnet-5-harness")?.tools, null);
    // Oracle has none at all.
    assert.equal(body.data.find((m) => m.id === "claude-sonnet-5")?.tools, null);
  });

  test("a semi request runs and is recorded under its own mode", async () => {
    const res = await chat({
      model: "claude-sonnet-5-semi",
      messages: [{ role: "user", content: "look around" }],
    });
    assert.equal(res.status, 200);

    const sessions = (await (
      await fetch(`${server.base}/admin/sessions?api_key=test-token`)
    ).json()) as { sessions: Array<{ mode: string; tools: string[] | null }> };

    const semi = sessions.sessions.find((s) => s.mode === "semi");
    assert.ok(semi, "expected a semi session");
    assert.deepEqual(semi.tools, [...READ_ONLY_TOOLS].sort());

    const usage = (await (
      await fetch(`${server.base}/admin/usage?mode=semi&api_key=test-token`)
    ).json()) as { summary: { turns: number } };
    assert.equal(usage.summary.turns, 1);
  });

  test("two tool sets are two sessions, never one shared process", async () => {
    const before = server.sessions.size;
    await chat(
      { model: "claude-sonnet-5-semi", messages: [{ role: "user", content: "same words" }] },
      { "x-claude-tools": "Read" },
    );
    await chat(
      { model: "claude-sonnet-5-semi", messages: [{ role: "user", content: "same words" }] },
      { "x-claude-tools": "Grep" },
    );
    // Identical prompts, different tools: the prefix must not match, because the
    // second process was spawned with flags the first one never had.
    assert.equal(server.sessions.size, before + 2);
  });

  test("a request that asks for nothing available is rejected", async () => {
    const res = await chat(
      { model: "claude-sonnet-5-semi", messages: [{ role: "user", content: "hi" }] },
      { "x-claude-tools": "Bash" },
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { message: string } };
    assert.match(body.error.message, /semi mode/);
  });
});
