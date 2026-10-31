// When mail is read: first at once, then after each read; "check now"; a new interval; never two at once.

import { describe, expect, it, vi } from "vitest";
import { MailScheduler } from "../../src/server/scheduler.js";
import { manualTimers } from "./helpers.js";

function setup() {
  const clock = { now: new Date("2026-10-30T12:00:00Z") };
  const timers = manualTimers();
  let finish: () => void = () => {};
  const read = vi.fn(() => new Promise<void>((done) => (finish = done)));
  const scheduler = new MailScheduler(read, 15, () => clock.now, timers);
  const settle = async () => {
    finish();
    await new Promise((r) => setTimeout(r, 0));
  };
  return { clock, timers, read, scheduler, settle };
}

describe("MailScheduler", () => {
  it("reads at once, then the interval after the read finished", async () => {
    const { clock, timers, read, scheduler, settle } = setup();
    scheduler.start();
    expect(read).toHaveBeenCalledTimes(1);
    expect(scheduler.state()).toMatchObject({ running: true, nextAt: null, lastStartedAt: "2026-10-30T12:00:00.000Z" });
    clock.now = new Date("2026-10-30T12:02:00Z");
    await settle();
    expect(scheduler.state()).toMatchObject({ running: false, lastFinishedAt: "2026-10-30T12:02:00.000Z", nextAt: "2026-10-30T12:17:00.000Z" });
    expect(timers.pending.map((t) => t.ms)).toEqual([15 * 60_000]);
    timers.pending.shift()!.fn();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("checks now when asked, but never starts a second read during one", async () => {
    const { timers, read, scheduler, settle } = setup();
    scheduler.start();
    expect(scheduler.checkNow()).toBe("running");
    expect(read).toHaveBeenCalledTimes(1);
    await settle();
    expect(timers.pending).toHaveLength(1);
    expect(scheduler.checkNow()).toBe("started");
    expect(read).toHaveBeenCalledTimes(2);
    // The waiting timer is replaced, not doubled.
    expect(timers.pending).toHaveLength(0);
    await settle();
    expect(timers.pending).toHaveLength(1);
  });

  it("takes a new interval at once, counted from the end of the last read", async () => {
    const { clock, timers, scheduler, settle } = setup();
    scheduler.start();
    await settle();
    clock.now = new Date("2026-10-30T12:03:00Z");
    scheduler.setEvery(5);
    expect(timers.pending.map((t) => t.ms)).toEqual([2 * 60_000]);
    expect(scheduler.state()).toMatchObject({ everyMinutes: 5, nextAt: "2026-10-30T12:05:00.000Z" });
    // Already past due: reads straight away.
    clock.now = new Date("2026-10-30T12:30:00Z");
    scheduler.setEvery(10);
    expect(timers.pending.map((t) => t.ms)).toEqual([0]);
  });

  it("keeps going after a read fails", async () => {
    const clock = { now: new Date("2026-10-30T12:00:00Z") };
    const timers = manualTimers();
    const scheduler = new MailScheduler(() => Promise.reject(new Error("Bridge down")), 15, () => clock.now, timers);
    vi.spyOn(console, "error").mockImplementation(() => {});
    scheduler.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(scheduler.state().running).toBe(false);
    expect(timers.pending).toHaveLength(1);
    vi.restoreAllMocks();
  });

  it("stops: no more reads, and waits for the one running", async () => {
    const { timers, read, scheduler, settle } = setup();
    scheduler.start();
    const stopped = scheduler.stop();
    await settle();
    await stopped;
    expect(timers.pending).toHaveLength(0);
    expect(scheduler.checkNow()).toBe("stopped");
    expect(read).toHaveBeenCalledTimes(1);
  });
});
