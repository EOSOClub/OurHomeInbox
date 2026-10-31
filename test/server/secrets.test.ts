// Saved passwords: sealed and opened with the install's key, bound to what they belong to.

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSecretKey, newSecretKey, SecretBox, SecretKeyError, SECRET_KEY_ENV } from "../../src/server/secrets.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ourhomeinbox-secrets-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("SecretBox", () => {
  const box = new SecretBox(Buffer.alloc(32, 7));

  it("opens what it sealed, and never stores it as written", () => {
    const sealed = box.seal("bridge password $&", "mailbox:proton-bills");
    expect(sealed).toMatch(/^v1:/);
    expect(sealed).not.toContain("bridge");
    expect(box.open(sealed, "mailbox:proton-bills")).toBe("bridge password $&");
  });

  it("seals the same password differently each time", () => {
    expect(box.seal("same", "x")).not.toBe(box.seal("same", "x"));
  });

  it("will not open a password for another mailbox, with another key, or changed", () => {
    const sealed = box.seal("secret", "mailbox:a");
    expect(box.open(sealed, "mailbox:b")).toBeNull();
    expect(new SecretBox(Buffer.alloc(32, 8)).open(sealed, "mailbox:a")).toBeNull();
    const raw = Buffer.from(sealed.slice(3), "base64");
    raw[raw.length - 1]! ^= 1;
    expect(box.open(`v1:${raw.toString("base64")}`, "mailbox:a")).toBeNull();
    expect(box.open("not sealed", "mailbox:a")).toBeNull();
    expect(box.open("v1:", "mailbox:a")).toBeNull();
  });
});

describe("loadSecretKey", () => {
  it("uses the key in .env, in base64 or hex", () => {
    const key = newSecretKey();
    expect(loadSecretKey(dir, { [SECRET_KEY_ENV]: key })).toEqual({ key: Buffer.from(key, "base64"), source: "env" });
    const hex = "ab".repeat(32);
    expect(loadSecretKey(dir, { [SECRET_KEY_ENV]: hex }).key).toEqual(Buffer.from(hex, "hex"));
  });

  it("refuses a key in .env that is not 32 bytes, saying how to fix it", () => {
    expect(() => loadSecretKey(dir, { [SECRET_KEY_ENV]: "too-short" })).toThrow(SecretKeyError);
    expect(() => loadSecretKey(dir, { [SECRET_KEY_ENV]: "too-short" })).toThrow(/32 random bytes/);
  });

  it("makes a key file once when .env has none, readable only by its owner, and keeps using it", () => {
    const first = loadSecretKey(dir, {});
    expect(first.source).toBe("file");
    const path = join(dir, "secret.key");
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadSecretKey(dir, {}).key).toEqual(first.key);
    expect(Buffer.from(readFileSync(path, "utf8").trim(), "base64")).toEqual(first.key);
  });

  it("refuses a damaged key file rather than making a new key that could not open saved passwords", () => {
    writeFileSync(join(dir, "secret.key"), "damaged\n");
    expect(() => loadSecretKey(dir, {})).toThrow(SecretKeyError);
  });
});
