import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { authHeaders, readSse, startTestServer, testConfig, type TestServer } from "./helpers.ts";
import { buildCodexPlan, seedPrompt } from "../src/codex/args.ts";
import { readSteps } from "../src/codex/rollout.ts";
import { billed } from "../src/core/usage.ts";
import type { Config } from "../src/core/config.ts";
import type { SessionClass } from "../src/core/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_CODEX = join(here, "fake-codex.mjs");

/** A config whose codex entries run the fake CLI against a throwaway home. */
function codexConfig(env: Record<string, string> = {}): Config {
  const cfg = testConfig();
  cfg.codex.binary = process.execPath;
  cfg.codex.binaryArgs = [FAKE_CODEX];
  // Its own CODEX_HOME, so the transcripts this run reads back are its own and
  // the operator's real ~/.codex is never touched.
  cfg.codex.home = mkdtempSync(join(tmpdir(), "socket-test-codex-"));
  cfg.codex.env = env;
  cfg.defaults.provider = "codex";
  cfg.defaults.model = "gpt-5.6-sol";
  return cfg;
}

function codexClass(overrides: Partial<SessionClass> = {}): SessionClass {
  return {
    provider: "codex",
    mode: "oracle",
    model: "gpt-5.6-sol",
    systemPrompt: "",
    effort: null,
    cwd: process.cwd(),
    jsonSchema: null,
    tools: { tools: null, allowed: [], disallowed: [] },
    ...overrides,
  };
}

async function chat(
  server: TestServer,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const res = await fetch(`${server.base}/v1/chat/completions`, {
    method: "POST",
    headers: { ...authHeaders(), ...headers },
    body: JSON.stringify(body),
  });
  return (await res.json()) as Record<string, unknown>;
}

function replyOf(body: Record<string, unknown>): string {
  const choices = body["choices"] as Array<{ message: { content: string } }> | undefined;
  return choices?.[0]?.message.content ?? "";
}

describe("codex command line", () => {
  it("puts every option ahead of the resume subcommand and the prompt last", () => {
    const cfg = codexConfig();
    const scratchDir = mkdtempSync(join(tmpdir(), "socket-test-plan-"));
    const plan = buildCodexPlan(cfg, codexClass({ effort: "high" }), {
      scratchDir,
      threadId: "thread-7",
    });

    // `codex exec` rejects a global flag that follows `resume`, and reads the
    // trailing `-` as a positional, so both positions are load-bearing.
    const resumeAt = plan.args.indexOf("resume");
    assert.ok(resumeAt > 0, "resume should be present");
    assert.equal(plan.args[resumeAt + 1], "thread-7");
    assert.equal(plan.args.at(-1), "-");
    assert.ok(plan.args.indexOf("--model") < resumeAt);
    assert.ok(plan.args.indexOf("--sandbox") < resumeAt);
    assert.ok(plan.args.includes("--json"));
    assert.ok(plan.args.includes("--ignore-user-config"));
    assert.ok(plan.args.includes("model_reasoning_effort=high"));
  });

  it("gives each mode its sandbox, since that is the only tool lever codex has", () => {
    const cfg = codexConfig();
    const scratchDir = mkdtempSync(join(tmpdir(), "socket-test-plan-"));
    const sandboxOf = (mode: SessionClass["mode"]) => {
      const plan = buildCodexPlan(cfg, codexClass({ mode }), { scratchDir });
      return plan.args[plan.args.indexOf("--sandbox") + 1];
    };
    assert.equal(sandboxOf("oracle"), "read-only");
    assert.equal(sandboxOf("semi"), "read-only");
    assert.equal(sandboxOf("harness"), "workspace-write");
  });

  it("carries the machine's windows sandbox setup across --ignore-user-config", (t) => {
    // Not a preference but machine setup, and losing it is silent: the agent
    // keeps its tools and every command it runs is refused. Skipped off
    // Windows, where there is nothing to carry.
    if (process.platform !== "win32") return t.skip("windows only");

    const cfg = codexConfig();
    const scratchDir = mkdtempSync(join(tmpdir(), "socket-test-plan-"));
    writeFileSync(
      join(cfg.codex.home, "config.toml"),
      '[a]\nsandbox = "wrong"\n\n[windows]\nsandbox = "elevated"\n\n[b]\nx = 1\n',
      "utf8",
    );

    const plan = buildCodexPlan(cfg, codexClass({ mode: "semi" }), { scratchDir });
    assert.ok(plan.args.includes("windows.sandbox=elevated"));

    // An operator override wins, and a machine that never ran the setup has no
    // value to carry, so nothing is invented for it.
    cfg.codex.configOverrides = { "windows.sandbox": "none" };
    const overridden = buildCodexPlan(cfg, codexClass({ mode: "semi" }), { scratchDir });
    assert.ok(overridden.args.includes("windows.sandbox=none"));
    assert.ok(!overridden.args.includes("windows.sandbox=elevated"));
  });

  it("folds the system prompt into the first message, and only when there is one", () => {
    // Codex takes no system-prompt flag, so this is the whole channel.
    assert.equal(seedPrompt("", "hello"), "hello");
    const seeded = seedPrompt("be terse", "hello");
    assert.ok(seeded.includes("be terse"));
    assert.ok(seeded.endsWith("hello"));
  });
});

describe("codex turns", () => {
  it("answers over the OpenAI dialect", async () => {
    const server = await startTestServer(codexConfig());
    try {
      const body = await chat(server, {
        model: "gpt-5.6-sol",
        messages: [{ role: "user", content: "ping" }],
      });
      assert.equal(replyOf(body), "echo1: ping");
    } finally {
      await server.close();
    }
  });

  it("resumes the thread instead of replaying the transcript", async () => {
    const server = await startTestServer(codexConfig());
    try {
      const first = await chat(server, {
        model: "gpt-5.6-sol",
        messages: [{ role: "user", content: "one" }],
      });
      assert.equal(replyOf(first), "echo1: one");

      // The turn counter lives in the thread's transcript, not in a process —
      // `codex exec` has already exited. A second turn that reports echo2 can
      // only have resumed; a fresh thread would say echo1 again.
      const second = await chat(server, {
        model: "gpt-5.6-sol",
        messages: [
          { role: "user", content: "one" },
          { role: "assistant", content: "echo1: one" },
          { role: "user", content: "two" },
        ],
      });
      assert.equal(replyOf(second), "echo2: two");
      assert.equal(server.sessions.size, 1, "one thread, not two");
    } finally {
      await server.close();
    }
  });

  it("delivers the system prompt, which codex has no flag for", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "socket-test-sys-")), "system.txt");
    const server = await startTestServer(codexConfig({ FAKE_SYSTEM_OUT: out }));
    try {
      await chat(server, {
        model: "gpt-5.6-sol",
        messages: [
          { role: "system", content: "answer only in haiku" },
          { role: "user", content: "ping" },
        ],
      });
      // The only proof available for a channel with no flag behind it: the CLI
      // received the prompt as part of the opening message.
      assert.equal(readFileSync(out, "utf8"), "answer only in haiku");
    } finally {
      await server.close();
    }
  });

  it("reports an upstream failure with the status the API gave it", async () => {
    const cfg = codexConfig({
      FAKE_FAIL: JSON.stringify({
        type: "error",
        status: 400,
        error: { type: "invalid_request_error", message: "model not supported" },
      }),
    });
    const server = await startTestServer(cfg);
    try {
      const res = await fetch(`${server.base}/v1/chat/completions`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          model: "gpt-5.6-sol",
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      // Codex passes the upstream error through as a JSON string; unwrapping it
      // is the difference between a useful 400 and a blanket 502.
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error: { message: string } };
      assert.match(body.error.message, /model not supported/);
    } finally {
      await server.close();
    }
  });

  it("streams a reply that reassembles to the non-streamed text", async () => {
    const server = await startTestServer(codexConfig());
    try {
      const res = await fetch(`${server.base}/v1/chat/completions`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          model: "gpt-5.6-sol",
          messages: [{ role: "user", content: "ping" }],
          stream: true,
        }),
      });
      const frames = await readSse(res);
      const text = frames
        .filter((f) => f !== "[DONE]")
        .map((f) => JSON.parse(f) as { choices?: Array<{ delta?: { content?: string } }> })
        .map((f) => f.choices?.[0]?.delta?.content ?? "")
        .join("");
      // Codex publishes whole items rather than token deltas, so this arrives in
      // one piece. What matters is that it is the same piece.
      assert.equal(text, "echo1: ping");
    } finally {
      await server.close();
    }
  });

  it("carries the reasoning summary, which codex actually fills in", async () => {
    const server = await startTestServer(codexConfig({ FAKE_THINKING: "weighing it up" }));
    try {
      const res = await fetch(`${server.base}/v1/chat/completions`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          model: "gpt-5.6-sol",
          messages: [{ role: "user", content: "ping" }],
          stream: true,
        }),
      });
      const frames = await readSse(res);
      const reasoning = frames
        .filter((f) => f !== "[DONE]")
        .map((f) => JSON.parse(f) as { choices?: Array<{ delta?: { reasoning_content?: string } }> })
        .map((f) => f.choices?.[0]?.delta?.reasoning_content ?? "")
        .join("");
      assert.equal(reasoning, "weighing it up");
    } finally {
      await server.close();
    }
  });
});

describe("codex token accounting", () => {
  it("pulls cached tokens back out of the input count", async () => {
    const server = await startTestServer(codexConfig());
    try {
      const body = await chat(server, {
        model: "gpt-5.6-sol",
        messages: [{ role: "user", content: "ping" }],
      });
      const usage = body["usage"] as Record<string, number> & {
        prompt_tokens_details: Record<string, number>;
      };
      // The fake reports codex's own shape for one call: input 1400, of which
      // 1000 cached and 100 cache-written. The socket's vocabulary keeps those
      // apart, so fresh input is 300 — not 1400, which would bill the cached
      // prefix a second time.
      assert.equal(usage.prompt_tokens_details["cached_tokens"], 1000);
      assert.equal(usage.prompt_tokens_details["cache_creation_tokens"], 100);
      assert.equal(usage.prompt_tokens, 1400);
      assert.equal(usage.completion_tokens, 10);
      // headline = fresh input + cache creation + output
      assert.equal(usage.billed_tokens, 300 + 100 + 10);
    } finally {
      await server.close();
    }
  });

  it("reports each model call in a tool loop, not just the turn total", async () => {
    const server = await startTestServer(codexConfig({ FAKE_TOOL: "ls -la" }));
    try {
      const body = await chat(server, {
        model: "gpt-5.6-sol-semi",
        messages: [{ role: "user", content: "look around" }],
      });
      const usage = body["usage"] as Record<string, unknown>;
      // Two billed calls: the one that asked to run the command, and the one
      // that read the result back. The turn aggregate alone could not say that.
      assert.equal(usage["steps"], 2);
      const steps = usage["step_usage"] as Array<Record<string, unknown>>;
      assert.equal(steps.length, 2);
      assert.deepEqual(steps[0]!["tools"], ["exec"]);
      assert.deepEqual(steps[1]!["tools"], []);
      assert.equal(usage["tool_call_count"], 1);
    } finally {
      await server.close();
    }
  });

  it("attributes the turn's tokens to the tool call that caused them", async () => {
    const server = await startTestServer(codexConfig({ FAKE_TOOL: "ls -la" }));
    try {
      await chat(server, {
        model: "gpt-5.6-sol-semi",
        messages: [{ role: "user", content: "look around" }],
      });
      const res = await fetch(`${server.base}/admin/usage/tools`, { headers: authHeaders() });
      const body = (await res.json()) as { tools: Array<{ name: string; totalTokens: number }> };
      const exec = body.tools.find((t) => t.name === "exec");
      assert.ok(exec, "the exec call should be priced");
      assert.ok(exec.totalTokens > 0);
    } finally {
      await server.close();
    }
  });

  it("falls back to the turn total when the transcript cannot be read", async () => {
    const cfg = codexConfig();
    cfg.codex.readRollout = false;
    const server = await startTestServer(cfg);
    try {
      const body = await chat(server, {
        model: "gpt-5.6-sol",
        messages: [{ role: "user", content: "ping" }],
      });
      const usage = body["usage"] as Record<string, unknown>;
      // Coarser, but never wrong: the numbers still reconcile with the headline.
      assert.equal(usage["steps"], 1);
      assert.equal(usage["billed_tokens"], 300 + 100 + 10);
    } finally {
      await server.close();
    }
  });
});

describe("codex rollout parsing", () => {
  it("closes a model call on its usage record and keeps the tools before it", () => {
    const dir = mkdtempSync(join(tmpdir(), "socket-test-rollout-"));
    const path = join(dir, "rollout.jsonl");
    const lines = [
      { type: "response_item", payload: { type: "custom_tool_call", call_id: "a", name: "exec", input: "ls" } },
      {
        type: "token_usage_record",
        payload: {
          response_id: "resp_1",
          usage: { input_tokens: 500, cached_input_tokens: 400, cache_write_input_tokens: 50, output_tokens: 7 },
        },
      },
      {
        type: "token_usage_record",
        payload: {
          response_id: "resp_2",
          usage: { input_tokens: 600, cached_input_tokens: 600, cache_write_input_tokens: 0, output_tokens: 3 },
        },
      },
    ];
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    const { steps, endByte } = readSteps(path, 0, "gpt-5.6-sol");
    assert.equal(steps.length, 2);
    assert.deepEqual(steps[0]!.tools.map((t) => t.name), ["exec"]);
    assert.equal(steps[0]!.tools[0]!.summary, "ls");
    assert.deepEqual(steps[1]!.tools, []);
    assert.equal(steps[0]!.usage.inputTokens, 50); // 500 - 400 cached - 50 written
    assert.equal(steps[0]!.usage.cacheReadTokens, 400);
    assert.equal(billed(steps[0]!.usage), 50 + 50 + 7);
    assert.equal(endByte, readFileSync(path).length);

    // A second read from the watermark sees nothing new, which is what keeps a
    // long conversation from re-parsing its whole transcript every turn.
    assert.deepEqual(readSteps(path, endByte, "gpt-5.6-sol").steps, []);
  });
});

describe("codex tool policy", () => {
  it("refuses a narrowing it cannot honour instead of ignoring it", async () => {
    const server = await startTestServer(codexConfig());
    try {
      const res = await fetch(`${server.base}/v1/chat/completions`, {
        method: "POST",
        headers: { ...authHeaders(), "x-claude-tools": "Read,Grep" },
        body: JSON.stringify({
          model: "gpt-5.6-sol-semi",
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      // Accepting it silently would leave a caller believing it had restricted
      // an agent that still holds everything it started with.
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error: { message: string } };
      assert.match(body.error.message, /no tool allowlist/);
    } finally {
      await server.close();
    }
  });
});

describe("codex model catalog", () => {
  it("routes by the catalog entry, and a mode header never changes backend", async () => {
    const server = await startTestServer(codexConfig());
    try {
      const res = await fetch(`${server.base}/v1/models`, { headers: authHeaders() });
      const body = (await res.json()) as {
        data: Array<{ id: string; provider: string; sandbox: string | null }>;
      };
      const sol = body.data.find((m) => m.id === "gpt-5.6-sol-semi");
      assert.equal(sol?.provider, "codex");
      assert.equal(sol?.sandbox, "read-only");
      const sonnet = body.data.find((m) => m.id === "claude-sonnet-5");
      assert.equal(sonnet?.provider, "claude");
      assert.equal(sonnet?.sandbox, null);
    } finally {
      await server.close();
    }
  });
});
