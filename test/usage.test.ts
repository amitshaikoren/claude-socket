import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, authHeaders, testConfig, type TestServer } from "./helpers.ts";
import {
  attributeTools,
  billed,
  contextSize,
  peakContext,
  rollUp,
  type Step,
} from "../src/core/usage.ts";
import { MemoryUsageStore, buildTurnRecord } from "../src/core/store.ts";
import type { Usage } from "../src/core/types.ts";

function usage(partial: Partial<Usage> = {}): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    ...partial,
  };
}

function step(index: number, u: Partial<Usage>, tools: string[] = []): Step {
  return {
    messageId: `msg_${index}`,
    index,
    model: "claude-sonnet-5",
    usage: usage(u),
    tools: tools.map((name, i) => ({ id: `toolu_${index}_${i}`, name, summary: "" })),
    at: Date.parse("2023-11-14T12:00:00Z") + index,
  };
}

describe("token accounting", () => {
  test("the headline excludes cache reads", () => {
    // Replayed history is priced at roughly a tenth and is re-sent on every lap
    // of a tool loop; counting it as billed volume is how a 20k conversation
    // reports 400k of usage.
    const u = usage({
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 200,
      cacheReadTokens: 9000,
    });
    assert.equal(billed(u), 350);
  });

  test("peak context is a high-water mark, not a sum", () => {
    const steps = [
      step(1, { cacheCreationTokens: 1000 }),
      step(2, { cacheReadTokens: 1000, cacheCreationTokens: 500 }),
      step(3, { cacheReadTokens: 1500, cacheCreationTokens: 100 }),
    ];
    assert.equal(contextSize(steps[1]!.usage), 1500);
    // The largest single call, not 1000 + 1500 + 1600.
    assert.equal(peakContext(steps), 1600);
  });

  test("a turn rolls up to the sum of its billed calls", () => {
    const steps = [
      step(1, { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 200 }, ["Read"]),
      step(2, { inputTokens: 20, outputTokens: 10, cacheReadTokens: 200 }),
    ];
    const totals = rollUp(steps, 0.25);
    assert.equal(totals.usage.inputTokens, 30);
    assert.equal(totals.usage.outputTokens, 15);
    assert.equal(totals.usage.cacheReadTokens, 200);
    assert.equal(totals.usage.cacheCreationTokens, 200);
    assert.equal(totals.headline, 30 + 200 + 15);
    assert.equal(totals.steps, 2);
    assert.equal(totals.toolCalls, 1);
    // Cost is never derived from tokens; it comes from the CLI verbatim.
    assert.equal(totals.usage.costUsd, 0.25);
  });

  test("cost is not apportioned across steps", () => {
    const steps = [step(1, { outputTokens: 5 }), step(2, { outputTokens: 5 })];
    assert.equal(rollUp(steps, 0.5).usage.costUsd, 0.5);
    for (const s of steps) assert.equal(s.usage.costUsd, 0);
  });
});

describe("tool call attribution", () => {
  test("a call costs the output that asked for it plus the input that read it back", () => {
    const steps = [
      step(1, { outputTokens: 60 }, ["Read"]),
      step(2, { inputTokens: 40, cacheCreationTokens: 100 }),
    ];
    const [call] = attributeTools(steps);
    assert.ok(call);
    assert.equal(call.name, "Read");
    assert.equal(call.step, 1);
    assert.equal(call.requestTokens, 60);
    assert.equal(call.resultTokens, 140);
    assert.equal(call.totalTokens, 200);
  });

  test("parallel calls in one step split that step's cost", () => {
    // The wire bills a call, not a block, so there is no per-block breakdown to
    // read: an even split is the only honest apportionment.
    const steps = [
      step(1, { outputTokens: 90 }, ["Read", "Grep", "Glob"]),
      step(2, { inputTokens: 30 }),
    ];
    const calls = attributeTools(steps);
    assert.equal(calls.length, 3);
    for (const call of calls) {
      assert.equal(call.requestTokens, 30);
      assert.equal(call.resultTokens, 10);
    }
    // Nothing is invented and nothing goes missing.
    assert.equal(calls.reduce((a, c) => a + c.totalTokens, 0), 120);
  });

  test("a call with no following step is charged only for the request", () => {
    const steps = [step(1, { outputTokens: 40 }, ["Bash"])];
    const [call] = attributeTools(steps);
    assert.equal(call?.requestTokens, 40);
    assert.equal(call?.resultTokens, 0);
  });

  test("steps without tools contribute no attributed calls", () => {
    assert.deepEqual(attributeTools([step(1, { outputTokens: 10 })]), []);
  });
});

describe("usage store", () => {
  const record = (overrides: Parameters<typeof buildTurnRecord>[0]) => buildTurnRecord(overrides);

  const base = {
    // Midday UTC, so the +2h case below stays inside one day bucket.
    startedAt: Date.parse("2023-11-14T12:00:00Z"),
    sessionId: "sess-1",
    dialect: "openai" as const,
    mode: "harness" as const,
    model: "claude-sonnet-5",
    advertisedModel: "claude-sonnet-5-harness",
    stream: false,
    cwd: "/tmp/ws",
    reused: false,
    ok: true,
    usage: usage({ inputTokens: 100, outputTokens: 50, cacheCreationTokens: 200 }),
    steps: [
      step(1, { inputTokens: 100, outputTokens: 30, cacheCreationTokens: 200 }, ["Read"]),
      step(2, { outputTokens: 20, cacheReadTokens: 300 }),
    ],
    clientToolCalls: 0,
    prompt: "read the notes",
    reply: "done",
  };

  test("summarizes, filters, buckets and rolls up tools", () => {
    const store = new MemoryUsageStore();
    store.record(record(base));
    store.record(
      record({
        ...base,
        startedAt: base.startedAt + 7_200_000,
        sessionId: "sess-2",
        mode: "oracle",
        advertisedModel: "claude-sonnet-5",
        steps: [step(1, { inputTokens: 10, outputTokens: 5 })],
        usage: usage({ inputTokens: 10, outputTokens: 5 }),
        prompt: "what is 6*7",
        reply: "42",
      }),
    );

    const all = store.summary({});
    assert.equal(all.turns, 2);
    assert.equal(all.steps, 3);
    assert.equal(all.toolCalls, 1);
    assert.equal(all.headline, 350 + 15);

    // Mode is a filter, not just a label.
    assert.equal(store.summary({ mode: "harness" }).turns, 1);
    assert.equal(store.summary({ mode: "oracle" }).headline, 15);

    // Free-text search covers the prompt and the reply.
    assert.equal(store.summary({ q: "notes" }).turns, 1);
    assert.equal(store.summary({ q: "42" }).turns, 1);

    // A tool filter selects the turns that actually ran it.
    assert.equal(store.summary({ tool: "Read" }).turns, 1);
    assert.equal(store.summary({ tool: "Bash" }).turns, 0);

    // Two hours apart: two hourly buckets, one daily.
    assert.equal(store.series({}, "hour").length, 2);
    assert.equal(store.series({}, "day").length, 1);

    const [tool] = store.tools({});
    assert.equal(tool?.name, "Read");
    assert.equal(tool?.calls, 1);
    assert.equal(tool?.turns, 1);

    const facets = store.facets();
    assert.deepEqual(facets.modes, ["harness", "oracle"]);
    assert.deepEqual(facets.tools, ["Read"]);
  });

  test("a time window excludes what falls outside it", () => {
    const store = new MemoryUsageStore();
    store.record(record(base));
    store.record(record({ ...base, startedAt: base.startedAt + 86_400_000 }));
    assert.equal(store.summary({ from: base.startedAt + 1000 }).turns, 1);
    assert.equal(store.summary({ to: base.startedAt + 1000 }).turns, 1);
    assert.equal(store.summary({ from: base.startedAt + 1e9 }).turns, 0);
  });

  test("failed turns are recorded, because they still cost tokens", () => {
    const store = new MemoryUsageStore();
    store.record(record({ ...base, ok: false, errorMessage: "boom" }));
    const summary = store.summary({});
    assert.equal(summary.turns, 1);
    assert.equal(summary.errors, 1);
    assert.ok(summary.headline > 0);
    assert.equal(store.summary({ status: "error" }).turns, 1);
    assert.equal(store.summary({ status: "ok" }).turns, 0);
  });

  test("steps are retrievable per turn", () => {
    const store = new MemoryUsageStore();
    const turn = record(base);
    store.record(turn);
    const steps = store.steps(turn.id);
    assert.equal(steps.length, 2);
    assert.equal(steps[0]?.tools[0]?.name, "Read");
  });
});

describe("usage over HTTP", () => {
  let server: TestServer;

  before(async () => {
    const cfg = testConfig();
    cfg.claude.env = { FAKE_TOOL_USE: "1" };
    server = await startTestServer(cfg);
  });
  after(async () => server.close());

  const chat = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    fetch(`${server.base}/v1/chat/completions`, {
      method: "POST",
      headers: { ...authHeaders(), ...headers },
      body: JSON.stringify(body),
    });

  test("a response reports per-call usage, not just a turn total", async () => {
    const res = await chat({
      model: "claude-sonnet-5-harness",
      messages: [{ role: "user", content: "read the notes" }],
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      usage: {
        billed_tokens: number;
        steps: number;
        peak_context_tokens: number;
        step_usage: Array<{ index: number; billed_tokens: number; tools: string[] }>;
      };
    };

    // The fake CLI runs a tool, so the turn is two billed calls, not one.
    assert.equal(body.usage.steps, 2);
    assert.equal(body.usage.step_usage.length, 2);
    assert.deepEqual(body.usage.step_usage[0]?.tools, ["Read"]);
    assert.deepEqual(body.usage.step_usage[1]?.tools, []);

    // The steps reconcile with the turn.
    const summed = body.usage.step_usage.reduce((a, s) => a + s.billed_tokens, 0);
    assert.equal(summed, body.usage.billed_tokens);
    assert.ok(body.usage.peak_context_tokens > 0);
  });

  test("the history endpoint answers with what the turn cost", async () => {
    await chat({
      model: "claude-sonnet-5-harness",
      messages: [{ role: "user", content: "a distinctive phrase" }],
    });

    const res = await fetch(
      `${server.base}/admin/usage/turns?q=distinctive&api_key=test-token`,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      turns: Array<{ id: string; headline: number; mode: string; prompt: string }>;
    };
    assert.equal(body.turns.length, 1);
    const turn = body.turns[0]!;
    assert.equal(turn.mode, "harness");
    assert.ok(turn.headline > 0);
    assert.match(turn.prompt, /distinctive/);

    // And the same turn drills down into its individual model calls.
    const steps = await fetch(
      `${server.base}/admin/usage/turns/${turn.id}/steps?api_key=test-token`,
    );
    const stepBody = (await steps.json()) as { steps: Array<{ tools: Array<{ name: string }> }> };
    assert.equal(stepBody.steps.length, 2);
    assert.equal(stepBody.steps[0]?.tools[0]?.name, "Read");
  });

  test("output comes from message_delta, not the placeholder on the assistant record", async () => {
    // The real CLI puts the message_start snapshot on the `assistant` record,
    // where output_tokens is a placeholder. Verified against a live transcript:
    // messages the wire reported as 2/2/1 were actually 65/71/43. Reading the
    // placeholder under-reports output by ~97% and guts tool attribution, since
    // a call's request cost is the output spent emitting it.
    const res = await chat({
      model: "claude-sonnet-5-harness",
      messages: [{ role: "user", content: "read the notes" }],
    });
    const body = (await res.json()) as {
      usage: { step_usage: Array<{ index: number; output_tokens: number }> };
    };

    // The fake sends a placeholder of 2 and a final of 5 * call.
    assert.deepEqual(
      body.usage.step_usage.map((s) => s.output_tokens),
      [5, 10],
    );
    for (const step of body.usage.step_usage) {
      assert.notEqual(step.output_tokens, 2, "billed the placeholder, not the count");
    }
  });

  test("a restated message neither doubles usage nor duplicates its tools", async () => {
    // The real CLI re-emits an assistant message under the same id roughly 40%
    // of the time, often repeating tool_use blocks it already sent. Measured on
    // real transcripts, appending blindly inflates tool counts by ~27% and
    // summing the usage doubles every token figure.
    const cfg = testConfig();
    cfg.claude.env = { FAKE_TOOL_USE: "1", FAKE_RESTATE: "1" };
    const restating = await startTestServer(cfg);
    try {
      const res = await fetch(`${restating.base}/v1/chat/completions`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          model: "claude-sonnet-5-harness",
          messages: [{ role: "user", content: "read it" }],
        }),
      });
      const body = (await res.json()) as {
        usage: { steps: number; billed_tokens: number; step_usage: Array<{ tools: string[] }> };
      };

      // Two distinct model calls, not three: the restate is the same call.
      assert.equal(body.usage.steps, 2);
      // One Read, not two.
      assert.deepEqual(body.usage.step_usage[0]?.tools, ["Read"]);
      assert.equal(
        body.usage.step_usage.reduce((a, s) => a + s.tools.length, 0),
        1,
      );

      const summary = (await (
        await fetch(`${restating.base}/admin/usage?api_key=test-token`)
      ).json()) as { summary: { steps: number; toolCalls: number; headline: number } };
      assert.equal(summary.summary.steps, 2);
      assert.equal(summary.summary.toolCalls, 1);
      assert.equal(summary.summary.headline, body.usage.billed_tokens);
    } finally {
      await restating.close();
    }
  });

  test("tools roll up across turns", async () => {
    const res = await fetch(`${server.base}/admin/usage/tools?api_key=test-token`);
    const body = (await res.json()) as { tools: Array<{ name: string; calls: number }> };
    const read = body.tools.find((t) => t.name === "Read");
    assert.ok(read, "expected the Read tool in the rollup");
    assert.ok(read.calls >= 1);
  });

  test("a window filter narrows the summary", async () => {
    const wide = await (
      await fetch(`${server.base}/admin/usage?window=24h&api_key=test-token`)
    ).json() as { summary: { turns: number } };
    const narrow = await (
      await fetch(`${server.base}/admin/usage?from=${Date.now() + 60_000}&api_key=test-token`)
    ).json() as { summary: { turns: number } };

    assert.ok(wide.summary.turns > 0);
    assert.equal(narrow.summary.turns, 0);
  });

  test("the series endpoint buckets by time", async () => {
    const res = await fetch(`${server.base}/admin/usage/series?bucket=hour&api_key=test-token`);
    const body = (await res.json()) as { bucket: string; points: Array<{ headline: number }> };
    assert.equal(body.bucket, "hour");
    assert.ok(body.points.length >= 1);
    assert.ok(body.points[0]!.headline > 0);
  });
});
