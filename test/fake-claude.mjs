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

async function respond(prompt) {
  turn += 1;
  const reply = `echo${turn}: ${prompt}`;
  const messageId = `msg_${randomUUID().replace(/-/g, "")}`;

  emit({ type: "stream_event", event: { type: "message_start", message: { id: messageId } }, parent_tool_use_id: null });
  emit({
    type: "stream_event",
    event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    parent_tool_use_id: null,
  });

  if (process.env.FAKE_TOOL_USE === "1") {
    emit({
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        role: "assistant",
        content: [{ type: "tool_use", name: "Read", input: { file_path: "notes.md" } }],
      },
    });
  }

  for (const piece of reply.match(/.{1,7}/gs) ?? []) {
    emit({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } },
      parent_tool_use_id: null,
    });
    if (process.env.FAKE_SLOW === "1") await new Promise((r) => setTimeout(r, 25));
  }

  emit({ type: "stream_event", event: { type: "content_block_stop", index: 0 }, parent_tool_use_id: null });
  emit({
    type: "assistant",
    parent_tool_use_id: null,
    message: { role: "assistant", content: [{ type: "text", text: reply }] },
  });
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    stop_reason: "end_turn",
    num_turns: turn,
    total_cost_usd: 0.0001 * turn,
    usage: {
      input_tokens: 10 * turn,
      output_tokens: 5,
      cache_read_input_tokens: turn > 1 ? 100 : 0,
      cache_creation_input_tokens: turn === 1 ? 100 : 0,
    },
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
  queue.then(() => process.exit(0));
});
