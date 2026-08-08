import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../src/claude/sessions.ts";
import { testConfig, testClass } from "./helpers.ts";
import { extractToolCalls } from "../src/core/tools.ts";
import { ReplyStream } from "../src/core/tools.ts";
import type { TurnEvent } from "../src/core/types.ts";

/**
 * The invariant both dialects depend on: the text deltas of a turn, reassembled
 * the way `ReplyStream` reassembles them, equal the authoritative `done.text`.
 *
 * This cannot be proved — a CLI record whose text never arrived as deltas is
 * unrecoverable from the wire, so the relationship is an alignment rather than
 * a guarantee. What a test buys is the next best thing: the day the CLI emits a
 * shape this code did not anticipate, it fails here instead of silently
 * shipping a different answer to streaming clients. That failure mode is why
 * this file exists — the truncation bug survived two identical copies of the
 * handler and was found by a downstream client, not by the suite.
 *
 * The cases below are fixtures, not recorded traffic. Adding a real corpus
 * means feeding recorded stream-json into the same `collect`/`assertParity`
 * pair; nothing here assumes the fake.
 */

interface Turn {
  deltas: string[];
  text: string;
}

async function collect(env: Record<string, string>, prompt: string): Promise<Turn> {
  const cfg = testConfig();
  cfg.claude.env = env;
  const sessions = new SessionManager(cfg);
  try {
    const events = sessions.run({
      cls: testClass(),
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      pinnedSession: null,
      maxBudgetUsd: null,
      advertisedModel: "oracle",
    });

    const deltas: string[] = [];
    let text = "";
    for await (const event of events as AsyncIterable<TurnEvent>) {
      if (event.kind === "delta" && event.blockType === "text") deltas.push(event.text);
      else if (event.kind === "done") text = event.text;
      else if (event.kind === "error") assert.fail(`turn failed: ${event.message}`);
    }
    return { deltas, text };
  } finally {
    sessions.shutdown();
  }
}

/** Reassemble exactly as the dialect handlers do, then compare to the authority. */
function assertParity(turn: Turn, scanning: boolean): void {
  const reply = new ReplyStream(scanning);
  let streamed = "";
  for (const delta of turn.deltas) streamed += reply.push(delta);
  streamed += reply.finish();

  const authoritative = scanning ? extractToolCalls(turn.text).text : turn.text;
  assert.equal(streamed, authoritative, "the delta stream diverged from done.text");
}

describe("streamed text reassembles into the authoritative text", () => {
  test("a single text block", async () => {
    const turn = await collect({}, "hello");
    assert.equal(turn.text, "echo1: hello");
    assertParity(turn, false);
    assertParity(turn, true);
  });

  test("two text blocks, which the accumulator joins with a blank line", async () => {
    const turn = await collect({ FAKE_TEXT_BLOCKS: "2" }, "hi");
    assert.equal(turn.text, "block one\n\nblock two: hi");
    assert.ok(turn.deltas.join("").includes("\n\n"), "no separator reached the delta stream");
    assertParity(turn, false);
    assertParity(turn, true);
  });

  test("a turn that ran a tool loop", async () => {
    const turn = await collect({ FAKE_TOOL_USE: "1" }, "read it");
    assertParity(turn, false);
    assertParity(turn, true);
  });

  test("a reply ending in a character that could open a tool_call tag", async () => {
    // The scanner holds "<" back as a possible "<tool_call>"; only finish()
    // releases it. Reassembly without that flush loses the tail silently.
    const turn = await collect({}, "AB<");
    assert.ok(turn.text.endsWith("AB<"));
    assertParity(turn, true);
  });
});
