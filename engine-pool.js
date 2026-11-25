// Runs review searches on several Stockfish workers at once.

const MAX_POOL_SIZE = 4;

/** Use half the logical cores (at most four) and fewer engines where the browser reports little memory. */
export function enginePoolSize({ cores, memoryGB } = {}) {
  const byCores = Math.floor((Number.isFinite(cores) && cores > 0 ? cores : 2) / 2);
  let size = Math.max(1, Math.min(MAX_POOL_SIZE, byCores));
  // Each full-network worker holds its own copy of the network and hash table.
  if (Number.isFinite(memoryGB)) size = Math.min(size, memoryGB >= 8 ? MAX_POOL_SIZE : memoryGB >= 4 ? 2 : 1);
  return size;
}

export class EnginePool {
  /**
   * @param {() => object} createEngine makes an extra engine with the StockfishEngine interface.
   * @param {number} size total engines, including `primary`.
   * @param {object} primary an engine the caller owns. close() leaves it running.
   */
  constructor(createEngine, size, primary = createEngine()) {
    this.primary = primary;
    this.engines = [primary];
    for (let index = 1; index < size; index++) this.engines.push(createEngine());
    this.idle = [...this.engines];
    this.queue = [];
    this.closed = false;
  }

  get size() {
    return this.engines.length;
  }

  /**
   * Run `task(engine)` on the next free engine. Tasks start in the order they were queued, except that a
   * `priority` task (a search the player is waiting for) goes ahead of queued ones that are not.
   */
  run(task, { priority = false } = {}) {
    if (this.closed) return Promise.reject(new Error("Analysis cancelled"));
    return new Promise((resolve, reject) => {
      const job = { task, resolve, reject, priority };
      if (priority) {
        const firstOrdinary = this.queue.findIndex((queued) => !queued.priority);
        this.queue.splice(firstOrdinary < 0 ? this.queue.length : firstOrdinary, 0, job);
      } else {
        this.queue.push(job);
      }
      this.pump();
    });
  }

  pump() {
    while (!this.closed && this.idle.length && this.queue.length) {
      const engine = this.idle.shift();
      const job = this.queue.shift();
      // Start the engine before the task, so a task never runs twice: only a failed start is retried.
      Promise.resolve().then(() => (engine.ready ? undefined : engine.init?.())).then(
        () => Promise.resolve().then(() => job.task(engine)).then((value) => {
          this.release(engine);
          job.resolve(value);
        }, (error) => {
          this.release(engine);
          job.reject(error);
        }),
        (error) => {
          // An extra engine that cannot start (for example, out of memory) leaves the pool; its task moves on.
          if (!this.closed && engine !== this.primary && this.engines.length > 1) {
            this.engines = this.engines.filter((other) => other !== engine);
            engine.terminate?.();
            this.queue.unshift(job);
            this.pump();
            return;
          }
          this.release(engine);
          job.reject(error);
        },
      );
    }
  }

  release(engine) {
    if (this.closed || !this.engines.includes(engine)) return;
    this.idle.push(engine);
    this.pump();
  }

  /** Stop every engine, including the primary one, and reject queued tasks. */
  abort() {
    this.shutdown(true);
  }

  /** Free the extra engines after the review. The primary engine keeps running. */
  close() {
    this.shutdown(false);
  }

  shutdown(includePrimary) {
    if (this.closed) return;
    this.closed = true;
    for (const job of this.queue.splice(0)) job.reject(new Error("Analysis cancelled"));
    for (const engine of this.engines) {
      if (engine !== this.primary) engine.terminate?.();
      else if (includePrimary) engine.abort?.();
    }
    this.idle = [];
  }
}
