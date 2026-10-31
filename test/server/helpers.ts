// Shared set-up for the server tests: a temp folder holding the database, the
// capture store and (optionally) a built web app, plus small request helpers.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { buildCapture } from "../../src/capture.js";
import { loadConfig } from "../../src/config.js";
import { openDatabase, type Database } from "../../src/server/db.js";
import type { AppEnv } from "../../src/server/http.js";
import type { Timers } from "../../src/server/scheduler.js";
import { createService, type Service } from "../../src/server/service.js";
import { CaptureStore } from "../../src/store.js";

export const ORIGIN = "http://localhost";
export const BRIDGE_PASSWORD = "bridge-secret-do-not-leak";
export const ADMIN = { householdName: "The Smiths", name: "Sam Smith", email: "sam@example.com", password: "correct horse battery" };

/** The test install's config.yml: one Proton mailbox, copied into the database at first-time setup. */
export const TEST_CONFIG_YAML = `# The test install's settings.
log_level: info
web:
  port: 8080
capture:
  every_minutes: 15 # how often mail is read
mailboxes:
  - name: Proton bills
    provider: proton-bridge
    folder: Folders/Bills
    imap:
      host: 127.0.0.1
      port: 1143
      security: starttls
      username: sam@proton.me
      password_env: PROTON_BRIDGE_PASSWORD
`;

/** Timers that never fire on their own: tests run reads with checkNow and look at what was scheduled. */
export function manualTimers(): Timers & { pending: Array<{ fn: () => void; ms: number }> } {
  const pending: Array<{ fn: () => void; ms: number }> = [];
  return {
    pending,
    setTimeout: (fn, ms) => {
      const entry = { fn, ms };
      pending.push(entry);
      return entry;
    },
    clearTimeout: (handle) => {
      const at = pending.indexOf(handle as { fn: () => void; ms: number });
      if (at !== -1) pending.splice(at, 1);
    },
  };
}

export interface TestServer {
  app: Hono<AppEnv>;
  db: Database;
  store: CaptureStore;
  dir: string;
  /** The test install's config.yml. */
  configPath: string;
  service: Service;
  timers: ReturnType<typeof manualTimers>;
  /** Moves the app's clock. */
  clock: { now: Date };
  close(): void;
}

export function makeServer(
  options: { webRoot?: boolean; configYaml?: string; env?: NodeJS.ProcessEnv; readMail?: () => Promise<void> } = {},
): TestServer {
  const dir = mkdtempSync(join(tmpdir(), "ourhomeinbox-server-"));
  const dataDir = join(dir, "data");
  mkdirSync(dataDir, { recursive: true });
  const db = openDatabase(join(dataDir, "ourhomeinbox.db"));
  const store = new CaptureStore(join(dir, "captures"));
  const configPath = join(dir, "config.yml");
  writeFileSync(configPath, options.configYaml ?? TEST_CONFIG_YAML);
  const env: NodeJS.ProcessEnv = { PROTON_BRIDGE_PASSWORD: BRIDGE_PASSWORD, ...options.env, OURHOMEINBOX_CONFIG: configPath };
  let webRoot: string | null = null;
  if (options.webRoot) {
    webRoot = join(dir, "web");
    mkdirSync(join(webRoot, "assets"), { recursive: true });
    writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>OurHomeInbox</title><div id=root></div>");
    writeFileSync(join(webRoot, "assets", "app-abc123.js"), "console.log('app');");
  }
  const clock = { now: new Date("2026-10-29T12:00:00Z") };
  const timers = manualTimers();
  const service = createService({
    config: loadConfig(env),
    configPath,
    load: () => loadConfig(env),
    dataDir,
    db,
    store,
    webRoot,
    version: "0.1.0-test",
    env,
    now: () => clock.now,
    readMail: options.readMail ?? (async () => {}),
    timers,
  });
  return {
    app: service.app,
    db,
    store,
    dir,
    configPath,
    service,
    timers,
    clock,
    close() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface CallOptions {
  method?: string;
  /** Sent as JSON unless it is already a string. */
  body?: unknown;
  cookie?: string | null;
  headers?: Record<string, string>;
  /** Pretend the request came from this network address. */
  ip?: string;
}

export async function call(app: Hono<AppEnv>, path: string, options: CallOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { ...options.headers };
  let body: string | undefined;
  if (options.body !== undefined) {
    body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
    headers["Content-Type"] ??= "application/json";
  }
  if (options.cookie) headers.Cookie = options.cookie;
  const env = options.ip ? { incoming: { socket: { remoteAddress: options.ip } } } : undefined;
  return app.request(`${ORIGIN}${path}`, { method: options.method ?? "GET", headers, body }, env);
}

/** A response's JSON body, typed as the contract says it is. */
export async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** The `ohi_session=...` pair a response set, or null when it set none (or cleared it). */
export function sessionCookie(res: Response): string | null {
  for (const line of res.headers.getSetCookie()) {
    const pair = line.split(";")[0]!;
    if (pair.startsWith("ohi_session=") && pair !== "ohi_session=") return pair;
  }
  return null;
}

/** Runs first-time setup and returns the signed-in admin's cookie. */
export async function setUp(app: Hono<AppEnv>): Promise<string> {
  const res = await call(app, "/api/setup", { method: "POST", body: ADMIN });
  if (res.status !== 200) throw new Error(`setup failed: ${res.status} ${await res.text()}`);
  const cookie = sessionCookie(res);
  if (!cookie) throw new Error("setup set no cookie");
  return cookie;
}

/** A raw email with a Date header (or none), a text body and one PDF attachment named `attachmentName`. */
export function rawEmail(options: { subject: string; date?: string; attachmentName?: string; html?: string }): Buffer {
  const lines = ["From: Water Co <billing@water.example>", "To: sam@proton.me", `Subject: ${options.subject}`];
  if (options.date) lines.push(`Date: ${options.date}`);
  lines.push('Content-Type: multipart/mixed; boundary="b"', "", "--b", "Content-Type: text/plain", "", "See https://water.example/pay");
  if (options.html) lines.push("--b", "Content-Type: text/html", "", options.html);
  if (options.attachmentName !== undefined) {
    lines.push(
      "--b",
      "Content-Type: application/pdf",
      `Content-Disposition: attachment; filename="${options.attachmentName}"`,
      "Content-Transfer-Encoding: base64",
      "",
      "JVBERi0xLjQK",
    );
  }
  lines.push("--b--", "");
  return Buffer.from(lines.join("\r\n"));
}

export async function saveEmail(
  store: CaptureStore,
  raw: Buffer,
  where: { uid: number; uidValidity?: string; mailbox?: string; capturedAt?: string },
): Promise<string> {
  const result = await buildCapture(raw, {
    mailbox: where.mailbox ?? "Proton bills",
    folder: "Folders/Bills",
    uidValidity: where.uidValidity ?? "1700000000",
    uid: where.uid,
    capturedAt: new Date(where.capturedAt ?? "2026-10-29T12:00:00Z"),
  });
  return store.save(result, raw);
}
