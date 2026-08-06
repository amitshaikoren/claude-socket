/** Minimal FIFO mutex: one in-flight turn per CLI process. */
export class Mutex {
  #tail: Promise<void> = Promise.resolve();
  #locked = false;

  get locked(): boolean {
    return this.#locked;
  }

  /** Resolves with a release function once the lock is held. */
  acquire(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = () => {
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
