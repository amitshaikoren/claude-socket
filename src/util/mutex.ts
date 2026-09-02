/** Minimal FIFO mutex: one in-flight turn per CLI process. */
export class Mutex {
  #tail: Promise<void> = Promise.resolve();
  #locked = false;

  get locked(): boolean {
    return this.#locked;
  }

  /**
   * Resolves with a release function once the lock is held.
   *
   * Releasing twice is a no-op rather than a second unlock: callers release
   * early on some paths and again from a `finally`, and a stale release must
   * never clear the flag out from under whoever holds the lock now. `locked` is
   * what decides whether a session may be evicted or reaped, so it has to mean
   * what it says.
   */
  acquire(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      let released = false;
      release = () => {
        if (released) return;
        released = true;
        this.#locked = false;
        resolve();
      };
    });
    const wait = this.#tail.then(() => {
      this.#locked = true;
      return release;
    });
    this.#tail = this.#tail.then(() => next);
    return wait;
  }
}
