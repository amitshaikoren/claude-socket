#!/usr/bin/env node
/**
 * A stand-in for the `codex` CLI that speaks the same thread-event protocol.
 * Tests drive this instead of the real binary so the suite costs nothing and
 * behaves identically on every run.
 *
 * Behaviour: replies "echo<N>: <text>" where N is the turn number *within this
 * thread*, which is what lets tests prove a conversation was resumed rather
 * than started over. Unlike the fake Claude CLI, that counter cannot live in
 * the process — `codex exec` really does exit after every turn — so it is
 * recovered from the thread's own transcript, exactly as the real one recovers
 * its conversation.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const argv = process.argv.slice(2);
if (process.env.FAKE_ARGV_OUT) {
  writeFileSync(process.env.FAKE_ARGV_OUT, JSON.stringify(argv), "utf8");
}

if (argv.includes("--version")) {
  process.stdout.write("codex-cli 0.0.0-fake\n");
  process.exit(0);
}

function flag(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

const resumeAt = argv.indexOf("resume");
const threadId = resumeAt >= 0 ? argv[resumeAt + 1] : randomUUID();
const model = flag("--model") ?? "fake-codex-model";
const home = process.env.CODEX_HOME;

// The transcript the socket reads its per-call accounting back out of. Its path
// is the real CLI's: sessions/YYYY/MM/DD/rollout-<timestamp>-<thread>.jsonl.
const rollout = home
  ? join(home, "sessions", "2026", "09", "13", `rollout-2026-09-13T00-00-00-${threadId}.jsonl`)
  : null;

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

let ordinal = 0;
function record(type, payload) {
  if (!rollout) return;
  mkdirSync(dirname(rollout), { recursive: true });
  appendFileSync(
    rollout,
    JSON.stringify({ timestamp: new Date().toISOString(), ordinal: ordinal++, type, payload }) +
      "\n",
    "utf8",
  );
}

/** How many turns this thread has already answered, per its own transcript. */
function priorTurns() {
  if (!rollout) return 0;
  try {
    return readFileSync(rollout, "utf8")
      .split("\n")
      .filter((line) => line.includes('"turn_marker"')).length;
  } catch {
    return 0;
  }
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/**
 * Split the in-band system prompt back off the message.
 *
 * Codex takes no system-prompt flag, so the socket folds one into the opening
 * message. Undoing that here keeps the echo readable and lets a test assert
 * that the prompt arrived at all, which is the only way to check a channel that
 * has no flag of its own.
 */
function split(raw) {
  const match = /^<system_instructions>\n([\s\S]*?)\n<\/system_instructions>\n\n/.exec(raw);
  if (!match) return { system: "", body: raw };
  return { system: match[1], body: raw.slice(match[0].length) };
}

const { system, body: prompt } = split(readStdin().trim());
if (system && process.env.FAKE_SYSTEM_OUT) {
  writeFileSync(process.env.FAKE_SYSTEM_OUT, system, "utf8");
}
const turn = priorTurns() + 1;

emit({ type: "thread.started", thread_id: threadId });
emit({ type: "turn.started" });

if (process.env.FAKE_FAIL) {
  emit({ type: "turn.failed", error: { message: process.env.FAKE_FAIL } });
  process.exit(1);
}

record("turn_marker", { turn });

/**
 * Per-call usage, as the real CLI records it.
 *
 * Deliberately distinguishable per call, and deliberately in Codex's own
 * accounting — where `input_tokens` *includes* the cached and cache-written
 * counts — so a test can prove the socket pulls them back apart instead of
 * billing a cached prefix twice.
 */
function usage(n) {
  return {
    input_tokens: 1000 * n + 400,
    cached_input_tokens: 1000 * n,
    cache_write_input_tokens: 100,
    output_tokens: 10 * n,
    reasoning_output_tokens: 0,
    total_tokens: 1000 * n + 400 + 10 * n,
  };
}

const calls = [];

if (process.env.FAKE_THINKING) {
  emit({
    type: "item.completed",
    item: { id: "item_r", type: "reasoning", text: process.env.FAKE_THINKING },
  });
}

// A tool loop, when asked for one: a command, its result, then the reply. Two
// billed calls, so the attribution has something to divide.
if (process.env.FAKE_TOOL) {
  const command = process.env.FAKE_TOOL;
  emit({
    type: "item.started",
    item: { id: "item_0", type: "command_execution", command, status: "in_progress" },
  });
  record("response_item", {
    type: "custom_tool_call",
    id: "ctc_1",
    call_id: "call_1",
    name: "exec",
    input: command,
  });
  record("token_usage_record", { response_id: "resp_1", usage: usage(1) });
  calls.push(usage(1));
  emit({
    type: "item.completed",
    item: {
      id: "item_0",
      type: "command_execution",
      command,
      aggregated_output: "ok\n",
      exit_code: 0,
      status: "completed",
    },
  });
}

const text = `echo${turn}: ${prompt}`;
emit({ type: "item.completed", item: { id: "item_1", type: "agent_message", text } });
record("token_usage_record", { response_id: `resp_${calls.length + 1}`, usage: usage(calls.length + 1) });
calls.push(usage(calls.length + 1));

const total = calls.reduce(
  (sum, u) => ({
    input_tokens: sum.input_tokens + u.input_tokens,
    cached_input_tokens: sum.cached_input_tokens + u.cached_input_tokens,
    cache_write_input_tokens: sum.cache_write_input_tokens + u.cache_write_input_tokens,
    output_tokens: sum.output_tokens + u.output_tokens,
    reasoning_output_tokens: 0,
  }),
  {
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
  },
);

emit({ type: "turn.completed", usage: total });
process.exit(0);
