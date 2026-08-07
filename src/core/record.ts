/**
 * The one place a finished turn is written down.
 *
 * Both dialect handlers end a turn the same way — emit a live telemetry event,
 * persist a usage record — and both used to do it inline with a dozen duplicated
 * fields. Keeping it here means the activity feed and the usage history can
 * never drift apart, and a new field is added once.
 */

import { preview, telemetry } from "./telemetry.ts";
import { buildTurnRecord, type UsageStore } from "./store.ts";
import { billed, peakContext, type Step } from "./usage.ts";
import type { Mode, Usage } from "./types.ts";

export interface FinishedTurn {
  startedAt: number;
  sessionId: string;
  dialect: "openai" | "anthropic";
  mode: Mode;
  /** What the CLI was told. */
  model: string;
  /** What the client asked for and gets echoed back. */
  advertisedModel: string;
  stream: boolean;
  cwd: string;
  reused: boolean;
  usage: Usage;
  steps: Step[];
  /** Calls to the *caller's* tools, via the tagged protocol. */
  clientToolCalls: number;
  prompt: string;
  reply: string;
  /** Set when the turn failed; the record is kept either way. */
  error?: string | null;
}

/**
 * Record a completed turn.
 *
 * Failures are recorded too. A turn that died halfway still burned tokens, and
 * leaving it out of the history would make the totals quietly optimistic.
 */
export function recordTurn(store: UsageStore, turn: FinishedTurn): void {
  const ok = !turn.error;
  const agentToolCalls = turn.steps.reduce((sum, step) => sum + step.tools.length, 0);

  telemetry.emit(ok ? "turn" : "error", {
    sessionId: turn.sessionId,
    dialect: turn.dialect,
    model: turn.advertisedModel,
    mode: turn.mode,
    stream: turn.stream,
    reused: turn.reused,
    inputTokens: turn.usage.inputTokens,
    outputTokens: turn.usage.outputTokens,
    cacheReadTokens: turn.usage.cacheReadTokens,
    cacheCreationTokens: turn.usage.cacheCreationTokens,
    headline: billed(turn.usage),
    peakContext: peakContext(turn.steps),
    costUsd: turn.usage.costUsd,
    steps: turn.steps.length,
    // Two different things worth telling apart: what the agent ran itself, and
    // what it asked the caller to run.
    agentToolCalls,
    toolCalls: turn.clientToolCalls,
    durationMs: Date.now() - turn.startedAt,
    prompt: preview(turn.prompt),
    reply: preview(turn.reply),
    message: turn.error ?? undefined,
  });

  try {
    store.record(
      buildTurnRecord({
        startedAt: turn.startedAt,
        sessionId: turn.sessionId,
        dialect: turn.dialect,
        mode: turn.mode,
        model: turn.model,
        advertisedModel: turn.advertisedModel,
        stream: turn.stream,
        cwd: turn.cwd,
        reused: turn.reused,
        ok,
        errorMessage: turn.error ?? null,
        usage: turn.usage,
        steps: turn.steps,
        clientToolCalls: turn.clientToolCalls,
        prompt: preview(turn.prompt, 400),
        reply: preview(turn.reply, 400),
      }),
    );
  } catch {
    /* accounting must never take down a request that already succeeded */
  }
}
