import type { TurnEvent } from "../core/types.ts";

/**
 * Async queue that turns pushed events into an async iterable.
 *
 * Every provider driver produces its turn the same way — a parser pushes
 * events as lines arrive, the HTTP layer pulls them — so the buffering lives
 * here rather than in either driver.
 */
export class EventQueue {
  #items: TurnEvent[] = [];
  #waiter: ((v: IteratorResult<TurnEvent>) => void) | null = null;
  #closed = false;

  push(event: TurnEvent): void {
    if (this.#closed) return;
    if (this.#waiter) {
      const w = this.#waiter;
      this.#waiter = null;
      w({ value: event, done: false });
    } else {
      this.#items.push(event);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#waiter) {
      const w = this.#waiter;
      this.#waiter = null;
      w({ value: undefined as unknown as TurnEvent, done: true });
    }
  }

  get closed(): boolean {
    return this.#closed;
  }

  async *drain(): AsyncGenerator<TurnEvent> {
    for (;;) {
      if (this.#items.length > 0) {
        yield this.#items.shift()!;
        continue;
      }
      if (this.#closed) return;
      const next = await new Promise<IteratorResult<TurnEvent>>((resolve) => {
        this.#waiter = resolve;
      });
      if (next.done) return;
      yield next.value;
    }
  }
}

/** A one-event stream, for turns that fail before they can start. */
export async function* single(event: TurnEvent): AsyncGenerator<TurnEvent> {
  yield event;
}
