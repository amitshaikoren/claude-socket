/**
 * In-memory activity log powering the dashboard and the `watch` CLI.
 *
 * Deliberately not persisted: this is a window onto a running server, not an
 * audit trail, and conversation text should not outlive the process.
 */

export interface TelemetryEvent {
  seq: number;
  at: number;
  type: "request" | "turn" | "tool" | "session" | "error";
  [key: string]: unknown;
}

export interface Totals {
  startedAt: number;
  requests: number;
  turns: number;
  errors: number;
  /** Calls to the caller's own tools, via the tagged protocol. */
  toolCalls: number;
  /** Tools the agent ran itself, in the harness and semi modes. */
  agentToolCalls: number;
  /** Model calls: an agentic turn is many of these, a plain turn is one. */
  steps: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** input + cache creation + output. See core/usage.ts for why reads are out. */
  headline: number;
  /** High-water mark of a single call's context, across the process's lifetime. */
  peakContext: number;
  costUsd: number;
}

function zeroTotals(): Totals {
  return {
    startedAt: Date.now(),
    requests: 0,
    turns: 0,
    errors: 0,
    toolCalls: 0,
    agentToolCalls: 0,
    steps: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    headline: 0,
    peakContext: 0,
    costUsd: 0,
  };
}

const MAX_EVENTS = 500;

class Telemetry {
  #events: TelemetryEvent[] = [];
  #subscribers = new Set<(event: TelemetryEvent) => void>();
  #seq = 0;

  totals: Totals = zeroTotals();

  emit(type: TelemetryEvent["type"], data: Record<string, unknown>): void {
    const event: TelemetryEvent = { ...data, seq: ++this.#seq, at: Date.now(), type };

    this.#events.push(event);
    if (this.#events.length > MAX_EVENTS) this.#events.shift();

    switch (type) {
      case "request":
        this.totals.requests += 1;
        break;
      case "error":
        this.totals.errors += 1;
        // A failed turn still burned tokens; leaving them out would make the
        // totals quietly optimistic. Request-level errors carry no usage keys
        // and so contribute nothing.
        this.#addUsage(data);
        break;
      case "turn": {
        this.totals.turns += 1;
        this.#addUsage(data);
        break;
      }
      default:
        break;
    }

    for (const subscriber of this.#subscribers) {
      try {
        subscriber(event);
      } catch {
        /* a broken listener must not break the request that emitted */
      }
    }
  }

  #addUsage(data: Record<string, unknown>): void {
    const n = (key: string) => Number(data[key] ?? 0) || 0;
    this.totals.inputTokens += n("inputTokens");
    this.totals.outputTokens += n("outputTokens");
    this.totals.cacheReadTokens += n("cacheReadTokens");
    this.totals.cacheCreationTokens += n("cacheCreationTokens");
    this.totals.headline += n("headline");
    this.totals.costUsd += n("costUsd");
    this.totals.toolCalls += n("toolCalls");
    this.totals.agentToolCalls += n("agentToolCalls");
    this.totals.steps += n("steps");
    // A max, not a sum: this is how full the window got, not how much flowed.
    const peak = n("peakContext");
    if (peak > this.totals.peakContext) this.totals.peakContext = peak;
  }

  subscribe(fn: (event: TelemetryEvent) => void): () => void {
    this.#subscribers.add(fn);
    return () => this.#subscribers.delete(fn);
  }

  recent(limit = 100): TelemetryEvent[] {
    return this.#events.slice(-limit);
  }

  reset(): void {
    this.#events = [];
    this.totals = zeroTotals();
  }
}

export const telemetry = new Telemetry();

/** Short, safe excerpt of conversation text for the activity feed. */
export function preview(text: string, limit = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? flat.slice(0, limit - 1) + "…" : flat;
}
