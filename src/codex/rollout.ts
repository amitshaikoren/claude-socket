import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isRecord, num } from "../agent/spawn.ts";
import { summarizeToolInput } from "../core/activity.ts";
import type { Step, StepTool } from "../core/usage.ts";
import { log } from "../util/log.ts";

/**
 * Per-model-call token accounting for `codex`.
 *
 * `codex exec --json` reports one usage total for the whole turn, which is
 * exactly the figure this project exists to get underneath: a turn that ran
 * four tool calls is four billed requests, and one aggregate cannot say which
 * of them was expensive. The per-call numbers do exist — the CLI writes a
 * `token_usage_record` per request into the session's rollout transcript, next
 * to the `response_item` entries for the tool calls that request asked for — so
 * this reads them back out of that file.
 *
 * It is a private on-disk format and this module treats it as one: nothing here
 * throws, every field is read defensively, and a caller that gets no steps back
 * falls back to the turn aggregate rather than failing the request. Losing this
 * costs a coarser dashboard, not a broken turn.
 */

/** How many day-directories back to look for a thread's transcript. */
const RECENT_DAYS = 4;

/**
 * Find the rollout file for a thread.
 *
 * Transcripts are filed under `sessions/YYYY/MM/DD/` by creation date, so a
 * thread opened before midnight and resumed after it is not in today's
 * directory — hence a walk over the most recent few rather than a single guess.
 */
export function findRollout(home: string, threadId: string): string | null {
  const root = join(home, "sessions");
  const suffix = `-${threadId}.jsonl`;
  try {
    for (const dir of recentDayDirs(root)) {
      for (const name of readdirSync(dir)) {
        if (name.startsWith("rollout-") && name.endsWith(suffix)) return join(dir, name);
      }
    }
  } catch {
    /* no transcripts on disk, or no permission to look */
  }
  return null;
}

/** The newest few YYYY/MM/DD directories under `sessions`, newest first. */
function recentDayDirs(root: string): string[] {
  const out: string[] = [];
  const descend = (dir: string, depth: number): void => {
    if (out.length >= RECENT_DAYS) return;
    let names: string[];
    try {
      names = readdirSync(dir).sort().reverse();
    } catch {
      return;
    }
    for (const name of names) {
      if (out.length >= RECENT_DAYS) return;
      const child = join(dir, name);
      if (depth === 2) out.push(child);
      else descend(child, depth + 1);
    }
  };
  descend(root, 0);
  return out;
}

/** Current size of a file, or 0 when it is not there yet. */
export function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export interface RolloutRead {
  steps: Step[];
  /** Byte offset consumed, to become the next turn's watermark. */
  endByte: number;
}

/**
 * Read the model calls a turn made, starting from a byte watermark.
 *
 * Reading from a watermark rather than re-parsing the file keeps a long
 * conversation linear: a transcript that grows all session would otherwise be
 * read in full again on every turn.
 *
 * Records arrive in causal order — the assistant message, then the tool calls
 * it asked for, then the `token_usage_record` for the request that produced
 * them — so a call is closed when its usage record appears, and the tool calls
 * seen since the previous one belong to it. That is the same pairing the Claude
 * driver gets for free from per-message usage blocks, and it is what lets
 * `attributeTools` price an individual tool call on either backend.
 */
export function readSteps(path: string, fromByte: number, model: string): RolloutRead {
  let buf: Buffer;
  let endByte = fromByte;
  try {
    if (fileSize(path) <= fromByte) return { steps: [], endByte: fromByte };
    buf = readFileSync(path);
    endByte = buf.length;
  } catch (err) {
    log.debug("could not read codex rollout", {
      path,
      error: err instanceof Error ? err.message : String(err),
    });
    return { steps: [], endByte: fromByte };
  }

  // Slice at the watermark, then drop a leading partial line: a write may have
  // been in flight when the previous turn took its mark.
  let text = buf.subarray(fromByte).toString("utf8");
  if (fromByte > 0) {
    const nl = text.indexOf("\n");
    text = nl < 0 ? "" : text.slice(nl + 1);
  }

  const steps: Step[] = [];
  let pending: StepTool[] = [];

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a torn final line; the next watermark picks it up
    }
    if (!isRecord(entry)) continue;
    const payload = isRecord(entry["payload"]) ? entry["payload"] : null;
    if (!payload) continue;

    if (entry["type"] === "response_item") {
      const tool = toolOf(payload);
      if (tool) pending.push(tool);
      continue;
    }

    if (entry["type"] !== "token_usage_record") continue;
    const usage = isRecord(payload["usage"]) ? payload["usage"] : null;
    if (!usage) continue;

    const cacheRead = num(usage["cached_input_tokens"]);
    const cacheWrite = num(usage["cache_write_input_tokens"]);
    steps.push({
      messageId:
        typeof payload["response_id"] === "string"
          ? payload["response_id"]
          : `step_${steps.length + 1}`,
      index: steps.length + 1,
      model,
      usage: {
        // Codex counts cached and freshly written tokens *inside* input_tokens;
        // the socket's vocabulary — and Anthropic's — keeps them apart, and the
        // headline depends on the difference. Subtracting here is what stops a
        // cached prefix being billed twice over in the totals.
        inputTokens: Math.max(0, num(usage["input_tokens"]) - cacheRead - cacheWrite),
        // Reasoning tokens are already inside this figure, not beside it.
        outputTokens: num(usage["output_tokens"]),
        cacheReadTokens: cacheRead,
        cacheCreationTokens: cacheWrite,
        // Codex reports no price, and prices are not ours to assume. Cost stays
        // zero rather than becoming a guess — the same rule the Claude driver
        // follows when the CLI gives it no `total_cost_usd`.
        costUsd: 0,
      },
      tools: pending,
      at: Date.parse(String(entry["timestamp"] ?? "")) || Date.now(),
    });
    pending = [];
  }

  return { steps, endByte };
}

/** The tool-call shapes a `response_item` can carry, flattened to one form. */
function toolOf(payload: Record<string, unknown>): StepTool | null {
  const type = String(payload["type"] ?? "");
  switch (type) {
    case "custom_tool_call":
    case "function_call":
    case "local_shell_call":
    case "tool_search_call":
    case "web_search_call":
    case "image_generation_call":
      break;
    default:
      return null;
  }
  // `input` on a custom tool call, `arguments` on a function call — both are
  // strings of whatever the tool takes rather than the object shape the Claude
  // side sees, so the summary comes from the raw text.
  const raw = payload["input"] ?? payload["arguments"] ?? payload["action"] ?? payload["query"];
  return {
    id: typeof payload["call_id"] === "string" ? payload["call_id"] : String(payload["id"] ?? ""),
    name: typeof payload["name"] === "string" ? payload["name"] : type.replace(/_call$/, ""),
    summary: summarizeToolInput(raw),
  };
}
