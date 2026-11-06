// Folders to leave out (mailbox.ts, owner 2026-11-05): an email also in one of
// them is not captured. Tried against a stand-in for a signed-in IMAP
// connection, so no mail server is needed.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureFolders, type FolderRead, type ImapReader } from "../src/mailbox.js";
import { CaptureStore } from "../src/store.js";

interface Message {
  uid: number;
  messageId: string | null;
  source: Buffer;
}

/** A bill email from the city, with its Message-ID (none when null). */
function email(messageId: string | null, subject: string): Buffer {
  const lines = ["From: City <billing@siouxfalls.example>", "To: sam@proton.me", `Subject: ${subject}`, "Date: Thu, 13 Aug 2026 12:00:00 +0000"];
  if (messageId) lines.push(`Message-ID: ${messageId}`);
  lines.push("Content-Type: text/plain", "", "Bill Amount: $121.44", "");
  return Buffer.from(lines.join("\r\n"));
}

/** A signed-in connection to a mailbox holding `folders`, read-only as the real one is opened. */
class StandIn {
  mailbox: { exists: number } | false = false;
  private open = "";
  constructor(private readonly folders: Record<string, Message[]>) {}

  async mailboxOpen(path: string) {
    const messages = this.folders[path];
    if (!messages) throw new Error("Unknown Mailbox");
    this.open = path;
    this.mailbox = { exists: messages.length };
    return { path, uidValidity: 1700000000n, exists: messages.length };
  }

  async list() {
    return Object.keys(this.folders).map((path) => ({ path }));
  }

  async fetchAll(range: string) {
    const messages = this.folders[this.open]!;
    const uids = range === "1:*" ? null : range.split(",").map(Number);
    return messages
      .filter((message) => uids === null || uids.includes(message.uid))
      .map((message) => ({ uid: message.uid, size: message.source.length, envelope: { messageId: message.messageId ?? undefined } }));
  }

  async fetchOne(uid: string) {
    const message = this.folders[this.open]!.find((m) => m.uid === Number(uid));
    return message ? { uid: message.uid, source: message.source } : false;
  }
}

let dir: string;
let store: CaptureStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ourhomeinbox-leave-out-"));
  store = new CaptureStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const BILLS: Message[] = [
  { uid: 1, messageId: "<new-bill-1@siouxfalls.example>", source: email("<new-bill-1@siouxfalls.example>", "Sioux Falls Utilities - New Bill") },
  { uid: 2, messageId: "<invoice-1@siouxfalls.example>", source: email("<invoice-1@siouxfalls.example>", "Invoice# 14221231 Notification") },
  { uid: 3, messageId: null, source: email(null, "No Message-ID") },
];

const read = (folders: Record<string, Message[]>, skipFolders?: string[]) =>
  captureFolders(new StandIn(folders) as unknown as ImapReader, { name: "Shawns Bills", folders: [{ folder: "Folders/Bills", slug: "bills" }], skipFolders }, store);

const summary = (reads: FolderRead[]) => ("summary" in reads[0]! ? reads[0].summary : reads[0]!.problem);

describe("folders to leave out", () => {
  it("does not capture an email that is also in a folder to leave out, matched by Message-ID", async () => {
    // The label holds the same email; the Bridge may write its Message-ID without the angle brackets.
    const reads = await read({ "Folders/Bills": BILLS, "Labels/Skip": [{ uid: 7, messageId: "new-bill-1@siouxfalls.example", source: BILLS[0]!.source }] }, ["Labels/Skip"]);
    expect(summary(reads)).toEqual({ inFolder: 3, alreadyCaptured: 0, captured: 2, failed: 0, tooLarge: 0, leftOut: 1 });
    expect([1, 2, 3].map((uid) => store.has("bills", "1700000000", uid))).toEqual([false, true, true]);
  });

  it("leaves out nothing without folders to leave out, or with an empty one", async () => {
    expect(summary(await read({ "Folders/Bills": BILLS }))).toMatchObject({ captured: 3, leftOut: 0 });
    rmSync(dir, { recursive: true, force: true });
    store = new CaptureStore(dir);
    expect(summary(await read({ "Folders/Bills": BILLS, "Labels/Skip": [] }, ["Labels/Skip"]))).toMatchObject({ captured: 3, leftOut: 0 });
  });

  it("keeps an email captured before it got the label", async () => {
    await read({ "Folders/Bills": BILLS });
    const again = await read({ "Folders/Bills": BILLS, "Labels/Skip": [BILLS[0]!] }, ["Labels/Skip"]);
    expect(summary(again)).toMatchObject({ alreadyCaptured: 3, captured: 0, leftOut: 0 });
    expect(store.has("bills", "1700000000", 1)).toBe(true);
  });

  it("reads nothing when a folder to leave out is missing, and says so for every folder", async () => {
    const reads = await read({ "Folders/Bills": BILLS, "Labels/Skip": [] }, ["Labels/Skipp"]);
    expect(reads).toEqual([
      { folder: "Folders/Bills", problem: 'Not read this time: the folder to leave out is missing. There is no folder called "Labels/Skipp". Folders in this mailbox: Folders/Bills, Labels/Skip' },
    ]);
    expect(store.has("bills", "1700000000", 2)).toBe(false);
  });
});
