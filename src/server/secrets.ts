// Keeping secrets (mailbox passwords) in the database, encrypted.
//
// AES-256-GCM: each secret gets its own random nonce, and GCM's tag means a
// changed or swapped value is refused rather than read wrongly. Each value is
// also bound to what it belongs to (the mailbox), so a password copied onto
// another mailbox's row cannot be read there.
//
// The key never goes in the database. It comes from .env
// (OURHOMEINBOX_SECRET_KEY, which docker/deploy.sh fills in) or, when that is
// not set (running from source, tests), from data/secret.key, made on first
// start and readable only by its owner. A copy of the database alone, such as
// a backup, gives no password away; the key in .env keeps them apart on disk.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SECRET_KEY_ENV = "OURHOMEINBOX_SECRET_KEY";
export const SECRET_KEY_FILE = "secret.key";

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const VERSION = "v1";

/** A key that is set but cannot be one. Its message says how to fix it. */
export class SecretKeyError extends Error {}

function parseKey(text: string, where: string): Buffer {
  const trimmed = text.trim();
  const key = /^[0-9a-f]{64}$/i.test(trimmed) ? Buffer.from(trimmed, "hex") : Buffer.from(trimmed, "base64");
  if (key.length !== KEY_BYTES) {
    throw new SecretKeyError(`${where} is not a key OurHomeInbox can use: it must be 32 random bytes, written as base64 (44 characters) or hex (64).`);
  }
  return key;
}

/** A new key, as written in .env or the key file. */
export function newSecretKey(): string {
  return randomBytes(KEY_BYTES).toString("base64");
}

/** The key from the environment, else from `dataDir`/secret.key (made when missing). */
export function loadSecretKey(dataDir: string, env: NodeJS.ProcessEnv = process.env): { key: Buffer; source: "env" | "file" } {
  const fromEnv = env[SECRET_KEY_ENV];
  if (fromEnv !== undefined && fromEnv.trim() !== "") return { key: parseKey(fromEnv, `${SECRET_KEY_ENV} in .env`), source: "env" };
  const path = join(dataDir, SECRET_KEY_FILE);
  if (!existsSync(path)) {
    try {
      // "wx": never overwrite a key that appeared meanwhile; 0600: only the owner can read it.
      writeFileSync(path, `${newSecretKey()}\n`, { flag: "wx", mode: 0o600 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  return { key: parseKey(readFileSync(path, "utf8"), path), source: "file" };
}

/** Seals and opens secrets with one key. */
export class SecretBox {
  constructor(private readonly key: Buffer) {
    if (key.length !== KEY_BYTES) throw new SecretKeyError("A secret key must be 32 bytes.");
  }

  /** "v1:<base64 of nonce, tag and ciphertext>", bound to `context` (what the secret belongs to). */
  seal(secret: string, context: string): string {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(context, "utf8"));
    const body = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    return `${VERSION}:${Buffer.concat([nonce, cipher.getAuthTag(), body]).toString("base64")}`;
  }

  /** The secret, or null when it was sealed with another key, for another context, or changed. */
  open(sealed: string, context: string): string | null {
    if (!sealed.startsWith(`${VERSION}:`)) return null;
    const raw = Buffer.from(sealed.slice(VERSION.length + 1), "base64");
    if (raw.length < NONCE_BYTES + TAG_BYTES) return null;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, NONCE_BYTES));
      decipher.setAAD(Buffer.from(context, "utf8"));
      decipher.setAuthTag(raw.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES));
      return Buffer.concat([decipher.update(raw.subarray(NONCE_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
    } catch {
      return null;
    }
  }
}
