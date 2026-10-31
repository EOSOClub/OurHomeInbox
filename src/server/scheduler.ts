// When mail is read: once at start, then every N minutes after the last read
// finished, and at once when someone presses "Check mail now". One read at a
// time: pressing it during a read does not start a second one. Changing N
// takes effect at once, counted from the end of the last read.

import { log } from "../log.js";
import type { CheckingState } from "../shared/api.js";

export interface Timers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export class MailScheduler {
  private timer: unknown = null;
  private current: Promise<void> | null = null;
  private stopped = false;
  private lastStartedAt: Date | null = null;
  private lastFinishedAt: Date | null = null;
  private nextAt: Date | null = null;

  constructor(
    private readonly read: () => Promise<void>,
    private everyMinutes: number,
    private readonly now: () => Date = () => new Date(),
    private readonly timers: Timers = realTimers,
  ) {}

  /** Starts reading: the first read right away. */
  start(): void {
    void this.run();
  }

  /** Reads now, unless a read is running or reading has stopped (the service is shutting down). Says which. */
  checkNow(): "started" | "running" | "stopped" {
    if (this.stopped) return "stopped";
    if (this.current) return "running";
    void this.run();
    return "started";
  }

  /** A new interval, counted from the end of the last read. */
  setEvery(minutes: number): void {
    this.everyMinutes = minutes;
    if (!this.current && this.lastFinishedAt) this.schedule();
  }

  state(): CheckingState {
    return {
      everyMinutes: this.everyMinutes,
      running: this.current !== null,
      lastStartedAt: this.lastStartedAt?.toISOString() ?? null,
      lastFinishedAt: this.lastFinishedAt?.toISOString() ?? null,
      nextAt: this.current ? null : (this.nextAt?.toISOString() ?? null),
    };
  }

  /** No more reads; waits for one that is running to finish. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.nextAt = null;
    await this.current;
  }

  private run(): Promise<void> {
    if (this.current || this.stopped) return this.current ?? Promise.resolve();
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.lastStartedAt = this.now();
    this.current = (async () => {
      try {
        await this.read();
      } catch (err) {
        log.error(`Reading mail failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.lastFinishedAt = this.now();
        this.current = null;
        this.schedule();
      }
    })();
    return this.current;
  }

  private schedule(): void {
    if (this.stopped || !this.lastFinishedAt) return;
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    const everyMs = this.everyMinutes * 60_000;
    this.nextAt = new Date(this.lastFinishedAt.getTime() + everyMs);
    const delay = Math.max(0, this.nextAt.getTime() - this.now().getTime());
    log.info(`Next mail check in ${Math.round(delay / 60_000)} minute(s)`);
    this.timer = this.timers.setTimeout(() => void this.run(), delay);
  }
}
