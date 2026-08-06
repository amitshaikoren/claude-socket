import type { ServerResponse } from "node:http";

/** Server-sent events writer used by both API dialects. */
export class SseWriter {
  #res: ServerResponse;
  #closed = false;

  constructor(res: ServerResponse, extraHeaders: Record<string, string> = {}) {
    this.#res = res;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Stops nginx and friends from buffering the stream into uselessness.
      "x-accel-buffering": "no",
      ...extraHeaders,
    });
    res.flushHeaders?.();
  }

  get closed(): boolean {
    return this.#closed || this.#res.writableEnded;
  }

  send(data: unknown, event?: string): void {
    if (this.closed) return;
    const payload = typeof data === "string" ? data : JSON.stringify(data);
    this.#res.write((event ? `event: ${event}\n` : "") + `data: ${payload}\n\n`);
  }

  comment(text: string): void {
    if (this.closed) return;
    this.#res.write(`: ${text}\n\n`);
  }

  end(): void {
    if (this.closed) return;
    this.#closed = true;
    this.#res.end();
  }
}
