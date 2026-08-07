/**
 * Token accounting vocabulary.
 *
 * One turn is not one model call. A harness turn loops — the agent asks for a
 * tool, reads the result, asks for another — and every lap is a separate billed
 * request with its own usage block. The CLI's final `result` message reports
 * only the aggregate, so anything finer than "what did this turn cost" has to
 * come from the per-message usage on each assistant message.
 *
 * The conventions here follow token-bench, so numbers from the two agree:
 *
 * - **headline** = input + cache_creation + output. What you were actually
 *   billed at full rate.
 * - **cache_read is excluded from the headline.** It is replayed history priced
 *   at roughly a tenth, and summing it across a loop counts the same prefix once
 *   per lap — which is how a 20k-token conversation reports 400k of "usage".
 *   It is still recorded, because it is the number that proves session reuse is
 *   working.
 * - **peak context** = the largest single call's (cache_read + cache_creation).
 *   A high-water mark of how full the window got, never a sum.
 */

import type { Usage } from "./types.ts";

/** One model call inside a turn, keyed by the assistant message it produced. */
export interface Step {
  /** Anthropic message id. The dedupe key: the CLI can restate a message. */
  messageId: string;
  /** Position within the turn, 1-based. */
  index: number;
  model: string;
  usage: Usage;
  /** Tools this call asked for, in the order they appeared. */
  tools: StepTool[];
  at: number;
}

export interface StepTool {
  /**
   * The `tool_use` block id. The dedupe key when the CLI restates a message:
   * measured against real transcripts, 27% of tool_use blocks arrive twice, and
   * appending blindly inflates every tool count by that much.
   */
  id: string;
  name: string;
  /** Short rendering of the primary argument, for display. */
  summary: string;
}

/** A tool call with tokens attributed to it. See {@link attributeTools}. */
export interface AttributedToolCall {
  name: string;
  summary: string;
  /** Index of the step that requested the call. */
  step: number;
  /** Output tokens spent emitting the request, split across the step's calls. */
  requestTokens: number;
  /** Billed input on the following call, i.e. reading this result back. */
  resultTokens: number;
  /** requestTokens + resultTokens. */
  totalTokens: number;
}

export function billed(usage: Usage): number {
  return usage.inputTokens + usage.cacheCreationTokens + usage.outputTokens;
}

/** How full the context window was for a single call. */
export function contextSize(usage: Usage): number {
  return usage.cacheReadTokens + usage.cacheCreationTokens;
}

export function addUsage(into: Usage, from: Usage): Usage {
  into.inputTokens += from.inputTokens;
  into.outputTokens += from.outputTokens;
  into.cacheReadTokens += from.cacheReadTokens;
  into.cacheCreationTokens += from.cacheCreationTokens;
  into.costUsd += from.costUsd;
  return into;
}

/** Largest single-call context across a turn. Deliberately a max, not a sum. */
export function peakContext(steps: Step[]): number {
  let peak = 0;
  for (const step of steps) {
    const size = contextSize(step.usage);
    if (size > peak) peak = size;
  }
  return peak;
}

/**
 * Attribute tokens to individual tool calls.
 *
 * A tool call costs twice. First the output tokens spent writing the request —
 * charged to the step that emitted it, split evenly when a step asks for several
 * at once, because the wire gives no per-block breakdown. Then the input tokens
 * on the *next* call, which is where the result is read back; that step's fresh
 * input plus cache creation is the price of everything the tools returned, so it
 * is divided across the calls that produced it.
 *
 * Both halves are apportioned, not measured: the API bills a call, not a block.
 * The totals always reconcile with the turn's headline, which is the property
 * that matters — no tokens are invented and none go missing.
 */
export function attributeTools(steps: Step[]): AttributedToolCall[] {
  const out: AttributedToolCall[] = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    if (step.tools.length === 0) continue;

    const share = step.tools.length;
    const request = step.usage.outputTokens / share;
    const next = steps[i + 1];
    // No following call means the turn ended before the results came back, so
    // nothing was paid to read them.
    const feedback = next ? (next.usage.inputTokens + next.usage.cacheCreationTokens) / share : 0;

    for (const tool of step.tools) {
      const requestTokens = Math.round(request);
      const resultTokens = Math.round(feedback);
      out.push({
        name: tool.name,
        summary: tool.summary,
        step: step.index,
        requestTokens,
        resultTokens,
        totalTokens: requestTokens + resultTokens,
      });
    }
  }

  return out;
}

/** Roll a turn's steps into the totals the dashboard and the store persist. */
export interface TurnTotals {
  usage: Usage;
  headline: number;
  peakContext: number;
  steps: number;
  toolCalls: number;
}

export function rollUp(steps: Step[], costUsd: number): TurnTotals {
  const usage: Usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd,
  };
  let toolCalls = 0;
  for (const step of steps) {
    usage.inputTokens += step.usage.inputTokens;
    usage.outputTokens += step.usage.outputTokens;
    usage.cacheReadTokens += step.usage.cacheReadTokens;
    usage.cacheCreationTokens += step.usage.cacheCreationTokens;
    toolCalls += step.tools.length;
  }
  return {
    usage,
    headline: billed(usage),
    peakContext: peakContext(steps),
    steps: steps.length,
    toolCalls,
  };
}
