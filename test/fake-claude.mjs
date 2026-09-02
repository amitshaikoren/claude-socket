#!/usr/bin/env node
/**
 * A stand-in for the `claude` CLI that speaks the same stream-json protocol.
 * Tests drive this instead of the real binary so the suite costs nothing and
 * behaves identically on every run.
 *
 * Behaviour: replies "echo<N>: <text>" where N is the turn number within this
 * process, which is what lets tests prove that a session was reused rather than
 * respawned.
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
if (process.env.FAKE_ARGV_OUT) {
  writeFileSync(process.env.FAKE_ARGV_OUT, JSON.stringify(argv), "utf8");
}

if (argv.includes("--version")) {
  process.stdout.write("0.0.0-fake (fake-claude)\n");
  process.exit(0);
}

const sessionId = process.env.FAKE_SESSION_ID || randomUUID();
let turn = 0;

// A helper process of the CLI's own — the real one has them, and the socket's
// grandchildren are deliberately outside the orphan sweep's reach: it targets
// direct children only, and lets `taskkill /T` take the subtree with the parent.
if (process.env.FAKE_SPAWN_CHILD) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], { stdio: "ignore" });
  writeFileSync(process.env.FAKE_SPAWN_CHILD, String(child.pid), "utf8");
}

function emit(obj) {
  process.stdout.write(JSON.stringify({ ...obj, session_id: sessionId }) + "\n");
}

emit({
  type: "system",
  subtype: "init",
  cwd: process.cwd(),
  tools: [],
  model: "fake-model",
  uuid: randomUUID(),
});

function textOf(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b?.type === "text").map((b) => b.text).join("\n");
}

/**
 * Per-message usage, as the real CLI reports it.
 *
 * Every assistant message is its own billed API call, so each one carries a
 * usage block. The numbers are deliberately distinguishable per call, which is
 * what lets a test tell "the turn total" apart from "the sum of its steps".
 *
 * `output_tokens` on the `assistant` record is a **placeholder**, exactly as the
 * real CLI sends it — the message_start snapshot, not a count. The real figure
 * arrives later in message_delta. Reproducing that here is the point: a fake
 * that reported the final number on the assistant record would have hidden the
 * bug where a 65-token message was billed as 2.
 */
const PLACEHOLDER_OUTPUT = 2;

function stepUsage(call) {
  return {
    input_tokens: 10 * call,
    output_tokens: PLACEHOLDER_OUTPUT,
    cache_read_input_tokens: call > 1 ? 100 * call : 0,
    cache_creation_input_tokens: call === 1 ? 200 : 0,
  };
}

/** What message_delta eventually reports for that call. */
function finalOutput(call) {
  return 5 * call;
}

async function respond(prompt) {
  turn += 1;

  // An upstream failure that leaves the CLI running, which is what a session
  // limit actually looks like: the turn ends in an error result and the process
  // stays up waiting for the next message. This is the shape that leaked — the
  // API layer throws on the error event and abandons the turn generator.
  if (process.env.FAKE_ERROR) {
    emit({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      api_error_status: Number(process.env.FAKE_ERROR),
      num_turns: turn,
      total_cost_usd: 0,
      usage: {},
      result: "upstream rejected the request",
    });
    return;
  }

  const reply = `echo${turn}: ${prompt}`;
  const messageId = `msg_${randomUUID().replace(/-/g, "")}`;
  let call = 0;
  const steps = [];

  const send = (n, content) =>
    emit({
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        id: `${messageId}_${n}`,
        role: "assistant",
        model: "fake-model",
        content,
        usage: stepUsage(n),
      },
    });

  /** The message_start / message_delta pair that brackets one model call. */
  const openCall = (n) =>
    emit({
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "message_start", message: { id: `${messageId}_${n}` } },
    });
  const closeCall = (n) =>
    emit({
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "message_delta", usage: { output_tokens: finalOutput(n) } },
    });

  const assistant = (content) => {
    call += 1;
    steps.push({ ...stepUsage(call), output_tokens: finalOutput(call) });
    openCall(call);
    send(call, content);
    closeCall(call);
  };

  /** Re-emit the message just sent, verbatim — what the real CLI does. */
  const replay = (content) => send(call, content);

  const openBlock = (index, type = "text") =>
    emit({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index,
        content_block: type === "thinking" ? { type: "thinking", thinking: "" } : { type: "text", text: "" },
      },
      parent_tool_use_id: null,
    });
  const thinkingDelta = (index, thinking) =>
    emit({
      type: "stream_event",
      event: { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking } },
      parent_tool_use_id: null,
    });
  const blockDelta = (index, text) =>
    emit({
      type: "stream_event",
      event: { type: "content_block_delta", index, delta: { type: "text_delta", text } },
      parent_tool_use_id: null,
    });
  const stopBlock = (index) =>
    emit({ type: "stream_event", event: { type: "content_block_stop", index }, parent_tool_use_id: null });

  // A turn whose reply arrives as two text blocks. The CLI joins them with a
  // blank line when it accumulates; the deltas carry no separator, which is the
  // divergence the streaming reassembly has to close.
  if (process.env.FAKE_TEXT_BLOCKS === "2") {
    const [first, second] = ["block one", `block two: ${prompt}`];
    for (const [index, part] of [first, second].entries()) {
      openBlock(index);
      for (const piece of part.match(/.{1,7}/gs) ?? []) blockDelta(index, piece);
      stopBlock(index);
    }
    assistant([
      { type: "text", text: first },
      { type: "text", text: second },
    ]);
    emit({
      type: "result",
      subtype: "success",
      is_error: false,
      stop_reason: "end_turn",
      num_turns: turn,
      total_cost_usd: 0.0001 * turn,
      usage: stepUsage(1),
      result: `${first}\n\n${second}`,
    });
    return;
  }

  // The model thinks before it answers. The real CLI emits this in oracle mode
  // too — stripping the agent does not stop the model from reasoning — so the
  // fake has to, or nothing downstream of the thinking gate can be tested.
  //
  // `redacted` is what the real CLI actually does as of 2.1.220, in every mode:
  // the thinking block and its deltas arrive, but the text is stripped down to
  // "" and only a signature survives. A fake that always spoke the thinking
  // aloud would hide the case the socket really meets in production.
  const redacted = process.env.FAKE_THINKING === "redacted";
  const thinking = process.env.FAKE_THINKING === "1" ? `pondering: ${prompt}` : "";
  const thinks = redacted || thinking !== "";
  if (thinks) {
    openBlock(0, "thinking");
    if (redacted) {
      thinkingDelta(0, "");
      thinkingDelta(0, "");
    } else {
      for (const piece of thinking.match(/.{1,7}/gs) ?? []) thinkingDelta(0, piece);
    }
    stopBlock(0);
  }
  // The text block follows the thinking one, so it is no longer index 0.
  const textIndex = thinks ? 1 : 0;

  openBlock(textIndex);

  if (process.env.FAKE_TOOL_USE === "1") {
    // A tool loop: one call asks, the next answers. Two billed calls, which is
    // the case per-step accounting exists for.
    const block = {
      type: "tool_use",
      id: `toolu_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
      name: "Read",
      input: { file_path: "notes.md" },
    };
    assistant([block]);
    // The real CLI restates a message under the same id ~40% of the time,
    // sometimes repeating tool_use blocks it already sent. Replaying it here
    // keeps the dedupe honest: usage must not double, and neither must tools.
    if (process.env.FAKE_RESTATE === "1") replay([block]);
    emit({
      type: "user",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [{ type: "tool_result", name: "Read", is_error: false, content: "file contents" }],
      },
    });
  }

  for (const piece of reply.match(/.{1,7}/gs) ?? []) {
    blockDelta(textIndex, piece);
    if (process.env.FAKE_SLOW === "1") await new Promise((r) => setTimeout(r, 25));
  }

  stopBlock(textIndex);
  assistant(
    thinks
      ? [{ type: "thinking", thinking }, { type: "text", text: reply }]
      : [{ type: "text", text: reply }],
  );

  // The turn aggregate, as the CLI reports it: the sum over every billed call.
  const total = steps.reduce(
    (a, u) => ({
      input_tokens: a.input_tokens + u.input_tokens,
      output_tokens: a.output_tokens + u.output_tokens,
      cache_read_input_tokens: a.cache_read_input_tokens + u.cache_read_input_tokens,
      cache_creation_input_tokens:
        a.cache_creation_input_tokens + u.cache_creation_input_tokens,
    }),
    {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  );

  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    stop_reason: "end_turn",
    num_turns: turn,
    total_cost_usd: 0.0001 * turn,
    usage: total,
    result: reply,
  });
}

let buffer = "";
let queue = Promise.resolve();

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.type === "control_request") {
      if (process.env.FAKE_IGNORE_INTERRUPT === "1") continue;
      emit({
        type: "control_response",
        response: { subtype: "success", request_id: msg.request_id },
      });
      continue;
    }
    if (msg.type === "user") {
      const prompt = textOf(msg.message);
      queue = queue.then(() => respond(prompt));
    }
  }
});

process.stdin.on("end", () => {
  // A CLI wedged in a retry loop never notices its stdin closed. Reproducing
  // that is what lets a test drive disposal past the polite stage and into the
  // kill it is supposed to verify.
  if (process.env.FAKE_IGNORE_STDIN_CLOSE === "1") {
    // Ignoring the event is not enough to stay up: with stdin done there is
    // nothing left holding the loop open, and node would exit anyway.
    setInterval(() => {}, 1e9);
    return;
  }
  queue.then(() => process.exit(0));
});
