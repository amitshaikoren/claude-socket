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
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

const MAX_EVENTS = 500;

class Telemetry {
  #events: TelemetryEvent[] = [];
  #subscribers = new Set<(event: TelemetryEvent) => void>();
  #seq = 0;

  totals: Totals = {
    startedAt: Date.now(),
    requests: 0,
    turns: 0,
    errors: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
  };

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
        break;
      case "turn": {
        this.totals.turns += 1;
        this.totals.inputTokens += Number(data["inputTokens"] ?? 0);
        this.totals.outputTokens += Number(data["outputTokens"] ?? 0);
        this.totals.cacheReadTokens += Number(data["cacheReadTokens"] ?? 0);
        this.totals.costUsd += Number(data["costUsd"] ?? 0);
        this.totals.toolCalls += Number(data["toolCalls"] ?? 0);
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

  subscribe(fn: (event: TelemetryEvent) => void): () => void {
    this.#subscribers.add(fn);
    return () => this.#subscribers.delete(fn);
  }

  recent(limit = 100): TelemetryEvent[] {
    return this.#events.slice(-limit);
  }

  reset(): void {
    this.#events = [];
    this.totals = {
      startedAt: Date.now(),
      requests: 0,
      turns: 0,
      errors: 0,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      costUsd: 0,
    };
  }
}

export const telemetry = new Telemetry();

/** Short, safe excerpt of conversation text for the activity feed. */
export function preview(text: string, limit = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? flat.slice(0, limit - 1) + "…" : flat;
}
