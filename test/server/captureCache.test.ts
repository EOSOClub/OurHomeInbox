// Reading captured emails once (captureCache.ts): an unchanged email's files
// are only stamped, a changed one is read again, and one that cannot be read
// is warned about once until it changes.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CaptureCache, dateHeaderOf } from "../../src/server/captureCache.js";
import type { MailboxPlace } from "../../src/server/mailboxes.js";
import { CaptureStore } from "../../src/store.js";
import { rawEmail, saveEmail } from "./helpers.js";

let dir: string;
let store: CaptureStore;
const places = [{ slug: "proton-bills", name: "Proton bills", folder: "Folders/Bills" } as unknown as MailboxPlace];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ourhomeinbox-cache-"));
  store = new CaptureStore(join(dir, "captures"));
  for (const uid of [1, 2, 3]) await saveEmail(store, rawEmail({ subject: `Bill ${uid}`, date: "Tue, 06 Oct 2026 20:30:00 -0500" }), { uid });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

async function all(cache: CaptureCache) {
  const found = [];
  for await (const email of cache.each(places, store)) found.push(email);
  return found;
}

describe("CaptureCache", () => {
  it("reads each email once, and again only when its files change", async () => {
    const cache = new CaptureCache();
    expect((await all(cache)).map((e) => e.subject).sort()).toEqual(["Bill 1", "Bill 2", "Bill 3"]);
    expect(cache.fileReads).toBe(3);
    await all(cache);
    await all(cache);
    expect(cache.fileReads).toBe(3);

    // A new invoice record beside one email: only that one is read again.
    writeFileSync(join(store.messageDir("Proton bills", "1700000000", 2), "invoice.json"), JSON.stringify({ version: 1, outcome: "failed", attempts: 1 }));
    const again = await all(cache);
    expect(cache.fileReads).toBe(4);
    expect(again.find((e) => e.uid === 2)!.invoice).toMatchObject({ outcome: "failed" });
  });

  it("warns once about an email it cannot read, until it changes", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const cache = new CaptureCache();
    writeFileSync(join(store.messageDir("Proton bills", "1700000000", 3), "capture.json"), "{ broken");
    expect(await all(cache)).toHaveLength(2);
    await all(cache);
    await all(cache);
    const about = () => warn.mock.calls.filter((call) => String(call.join(" ")).includes("capture.json")).length;
    expect(about()).toBe(1);
    writeFileSync(join(store.messageDir("Proton bills", "1700000000", 3), "capture.json"), "{ still broken");
    await all(cache);
    expect(about()).toBe(2);
  });

  it("drops what it kept for a message folder that is gone", async () => {
    const cache = new CaptureCache();
    await all(cache);
    expect(cache.kept).toBe(3);
    rmSync(store.messageDir("Proton bills", "1700000000", 2), { recursive: true, force: true });
    expect((await all(cache)).map((e) => e.uid).sort()).toEqual([1, 3]);
    expect(cache.kept).toBe(2);
  });

  it("warns once about a file it cannot even look at", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const cache = new CaptureCache();
    const place = { id: "proton-bills/1700000000/9", slug: "proton-bills", mailbox: places[0]!, uidValidity: "1700000000", uid: 9, dir: "bad\0dir" };
    expect(await cache.read(place)).toBeNull();
    expect(await cache.read(place)).toBeNull();
    expect(warn.mock.calls.filter((call) => String(call.join(" ")).includes("Could not read")).length).toBe(1);
  });

  it("keeps the Date header as received, for the sender's own day", async () => {
    const [email] = await all(new CaptureCache());
    expect(email!.dateHeader).toBe("Tue, 06 Oct 2026 20:30:00 -0500");
    expect(email!.date).toBe("2026-10-07T01:30:00.000Z");
    expect(dateHeaderOf({ headers: [] } as never)).toBeNull();
  });
});
