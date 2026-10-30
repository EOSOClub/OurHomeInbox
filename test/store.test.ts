import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCapture } from "../src/capture.js";
import { CaptureStore } from "../src/store.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ourhomeinbox-store-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const RAW = Buffer.from(
  [
    "From: billing@water.example",
    "Subject: Water bill",
    'Content-Type: multipart/mixed; boundary="b"',
    "",
    "--b",
    "Content-Type: text/plain",
    "",
    "Due soon.",
    "--b",
    "Content-Type: application/pdf",
    'Content-Disposition: attachment; filename="bill.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    "JVBERi0xLjQK",
    "--b--",
    "",
  ].join("\r\n"),
);

async function capture(uid = 7) {
  return buildCapture(RAW, {
    mailbox: "Proton bills",
    folder: "Folders/Bills",
    uidValidity: "1700000000",
    uid,
    capturedAt: new Date("2026-10-29T12:00:00Z"),
  });
}

describe("CaptureStore", () => {
  it("keeps one folder per message: raw email, attachments, capture.json", async () => {
    const store = new CaptureStore(root);
    const dir = await store.save(await capture(), RAW);
    expect(dir).toBe(join(root, "proton-bills", "1700000000", "7"));
    expect(readFileSync(join(dir, "message.eml"))).toEqual(RAW);
    expect(readdirSync(join(dir, "attachments"))).toEqual(["1-bill.pdf"]);
    const saved = JSON.parse(readFileSync(join(dir, "capture.json"), "utf8"));
    expect(saved).toMatchObject({ subject: "Water bill", uid: 7, attachments: [{ file: "attachments/1-bill.pdf" }] });
    expect(existsSync(join(dir, "capture.json.tmp"))).toBe(false);
  });

  it("counts a message as captured only once capture.json exists", async () => {
    const store = new CaptureStore(root);
    expect(store.has("Proton bills", "1700000000", 7)).toBe(false);
    await store.save(await capture(), RAW);
    expect(store.has("Proton bills", "1700000000", 7)).toBe(true);
    expect(store.has("Proton bills", "1700000000", 8)).toBe(false);
    expect(store.has("Proton bills", "1700000001", 7)).toBe(false);
  });

  it("clears what an interrupted run left behind", async () => {
    const store = new CaptureStore(root);
    const dir = store.messageDir("Proton bills", "1700000000", 7);
    mkdirSync(join(dir, "attachments"), { recursive: true });
    writeFileSync(join(dir, "attachments", "9-left-over.bin"), "partial");
    await store.save(await capture(), RAW);
    expect(readdirSync(join(dir, "attachments"))).toEqual(["1-bill.pdf"]);
  });

  it("never overwrites a captured message", async () => {
    const store = new CaptureStore(root);
    await store.save(await capture(), RAW);
    await expect(store.save(await capture(), RAW)).rejects.toThrow("already captured");
  });

  it("refuses a UIDVALIDITY or uid that could make a strange path", () => {
    const store = new CaptureStore(root);
    expect(() => store.messageDir("Proton bills", "../x", 1)).toThrow();
    expect(() => store.messageDir("Proton bills", "1", 0)).toThrow();
    expect(() => store.messageDir("Proton bills", "1", 1.5)).toThrow();
  });
});
