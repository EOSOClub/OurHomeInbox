// The household's mailboxes: where its bills are read from.
//   GET    /api/mailboxes        the household's mailboxes and when mail is read
//   POST   /api/mailboxes        add one (admin)
//   PUT    /api/mailboxes/:id    change one; a password left out keeps the saved one (admin)
//   DELETE /api/mailboxes/:id    remove one; its captured mail stays on disk (admin)
//   POST   /api/mailboxes/test   try settings before saving them (admin)
//   POST   /api/mailboxes/check  read every mailbox now
//
// Mailboxes are kept in the database, per household, with their passwords
// encrypted (secrets.ts); a password is never sent back, only whether one is
// saved, and a saved one is only ever sent to the server it was saved for:
// changing the server, port, security or username needs it typed again. Each mailbox's captured mail sits under data/mail/<slug>: the slug is
// unique across the install and kept when the mailbox is renamed.
//
// Only an admin may add or change mailboxes for now; household roles come
// with adding people. Another household's mailbox is "not found".

import { existsSync } from "node:fs";
import { join } from "node:path";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Config } from "../config.js";
import { mailboxSlug } from "../config.js";
import { log } from "../log.js";
import { captureMailbox, MailboxError, testMailbox, type MailboxToRead } from "../mailbox.js";
import type { CheckingState, MailboxInfo, MailboxListResponse, MailboxTestResponse } from "../shared/api.js";
import {
  MAX_MAILBOX_FOLDER,
  MAX_MAILBOX_HOST,
  MAX_MAILBOX_NAME,
  MAX_MAILBOX_PASSWORD,
  MAX_MAILBOX_USERNAME,
  PROVIDERS,
  SECURITY_MODES,
  type Provider,
  type Security,
} from "../shared/settings.js";
import type { CaptureStore } from "../store.js";
import type { Database } from "./db.js";
import { apiError, householdOf, jsonBody, MESSAGES, type AppEnv } from "./http.js";
import type { SecretBox } from "./secrets.js";

const NOT_FOUND = "That mailbox was not found. It may have been removed.";
const ADMIN_ONLY = "Only an admin can change mailboxes.";
const KEY_CHANGED = "The saved password can no longer be read: the key that protects saved passwords has changed. Enter the password again.";
const IMPORTED_KEY = "config_mailboxes_imported";
const ID = /^[1-9]\d*$/;

/** Where a mailbox's mail is, for listing it. */
export interface MailboxPlace {
  slug: string;
  name: string;
  folder: string;
}

interface MailboxRow {
  id: number;
  household_id: number;
  name: string;
  slug: string;
  provider: Provider;
  host: string;
  port: number;
  security: Security;
  username: string;
  password_secret: string;
  folder: string;
  enabled: number;
  last_checked_at: string | null;
  last_outcome: string | null;
  last_message: string | null;
  last_captured: number | null;
  created_at: string;
  updated_at: string;
}

/** The secret's context: a password sealed for one mailbox cannot be opened as another's. */
const context = (slug: string) => `mailbox:${slug}`;

const SERVER_CHANGED = "Enter the password again to use a different server, port, security or username. A saved password is only ever sent to the server it was saved for.";

/**
 * True when `fields` name the same server and login a saved password was
 * saved for. A saved password is only ever sent there: otherwise anyone who
 * could change a mailbox (a stolen admin session, say) could point it at a
 * server of their own and receive the password.
 */
function sameServer(
  row: Pick<MailboxRow, "provider" | "host" | "port" | "security" | "username">,
  fields: { provider: string; host: string; port: number; security: string; username: string },
): boolean {
  return (
    row.provider === fields.provider &&
    row.host.toLowerCase() === fields.host.toLowerCase() &&
    row.port === fields.port &&
    row.security === fields.security &&
    row.username === fields.username
  );
}

// ---- Checks on what is sent ---------------------------------------------------

const connectionFields = {
  provider: z.enum(PROVIDERS, { error: "Choose the kind of mailbox." }),
  host: z
    .string({ error: "Enter the IMAP server's address." })
    .trim()
    .min(1, "Enter the IMAP server's address.")
    .max(MAX_MAILBOX_HOST, "That server address is too long.")
    .regex(/^[A-Za-z0-9._:[\]-]+$/, "Enter just the server's name or address, like 127.0.0.1 or protonmail-bridge, with no spaces or slashes."),
  port: z
    .number({ error: "Enter the IMAP port as a number, like 1143." })
    .int("Enter the IMAP port as a whole number.")
    .min(1, "The port must be between 1 and 65535.")
    .max(65535, "The port must be between 1 and 65535."),
  security: z.preprocess(
    (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
    z.enum(SECURITY_MODES, { error: "Choose how the connection is protected." }),
  ),
  username: z
    .string({ error: "Enter the IMAP username." })
    .trim()
    .min(1, "Enter the IMAP username.")
    .max(MAX_MAILBOX_USERNAME, "That username is too long."),
  // Not trimmed: a password is used exactly as typed.
  password: z.string({ error: MESSAGES.badShape }).max(MAX_MAILBOX_PASSWORD, "That password is too long.").optional(),
  folder: z
    .string({ error: "Enter the folder to read." })
    .trim()
    .min(1, "Enter the folder to read, like INBOX or Folders/Bills.")
    .max(MAX_MAILBOX_FOLDER, "That folder name is too long."),
};

const mailboxSchema = z.object(
  {
    name: z
      .string({ error: "Enter a name for the mailbox." })
      .trim()
      .min(1, "Enter a name for the mailbox.")
      .max(MAX_MAILBOX_NAME, `Keep the name under ${MAX_MAILBOX_NAME} characters.`)
      .refine((name) => mailboxSlug(name) !== "", "The name needs at least one letter or number."),
    ...connectionFields,
    enabled: z.boolean({ error: MESSAGES.badShape }).optional(),
  },
  { error: MESSAGES.badShape },
);

const testSchema = z.object({ id: z.number().int().positive().optional(), ...connectionFields }, { error: MESSAGES.badShape });

type MailboxFields = z.output<typeof mailboxSchema>;

// ---- The mailboxes -----------------------------------------------------------

export class Mailboxes {
  constructor(
    private readonly db: Database,
    private readonly box: SecretBox,
    private readonly store: CaptureStore,
    private readonly now: () => Date,
  ) {}

  private rows(householdId: number): MailboxRow[] {
    return this.db.all<MailboxRow>("SELECT * FROM mailboxes WHERE household_id = ? ORDER BY name COLLATE NOCASE, id", householdId);
  }

  private row(householdId: number, id: number): MailboxRow | undefined {
    return this.db.get<MailboxRow>("SELECT * FROM mailboxes WHERE id = ? AND household_id = ?", id, householdId);
  }

  /** The saved password, "" when none is saved, or null when it cannot be read (the key changed). */
  private password(row: MailboxRow): string | null {
    if (row.password_secret === "") return "";
    return this.box.open(row.password_secret, context(row.slug));
  }

  private info(row: MailboxRow): MailboxInfo {
    const password = this.password(row);
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      provider: row.provider,
      folder: row.folder,
      imap: {
        host: row.host,
        port: row.port,
        security: row.security,
        username: row.username,
        passwordSet: password !== null && password !== "",
        passwordProblem: password === null ? KEY_CHANGED : null,
      },
      enabled: row.enabled !== 0,
      lastCheck:
        row.last_checked_at === null
          ? null
          : { at: row.last_checked_at, ok: row.last_outcome === "ok", message: row.last_message ?? "", captured: row.last_captured ?? 0 },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  list(householdId: number): MailboxInfo[] {
    return this.rows(householdId).map((row) => this.info(row));
  }

  get(householdId: number, id: number): MailboxInfo | null {
    const row = this.row(householdId, id);
    return row ? this.info(row) : null;
  }

  /** The household's mailboxes by slug, for finding and listing its captured mail. Paused ones included: their mail stays visible. */
  places(householdId: number): Map<string, MailboxPlace> {
    return new Map(this.rows(householdId).map((row) => [row.slug, { slug: row.slug, name: row.name, folder: row.folder }]));
  }

  households(): number[] {
    return this.db.all<{ household_id: number }>("SELECT DISTINCT household_id FROM mailboxes ORDER BY household_id").map((r) => r.household_id);
  }

  /** A slug for a new mailbox: its name's, made unique across the install and against folders already on disk. */
  private newSlug(name: string): string {
    const base = mailboxSlug(name);
    for (let n = 1; ; n++) {
      const slug = n === 1 ? base : `${base.slice(0, 55)}-${n}`;
      const taken = this.db.get("SELECT 1 FROM mailboxes WHERE slug = ?", slug) || existsSync(join(this.store.root, slug));
      if (!taken) return slug;
    }
  }

  private nameTaken(householdId: number, name: string, id: number | null): string | null {
    const same = this.db.get<{ name: string }>(
      "SELECT name FROM mailboxes WHERE household_id = ? AND name = ? COLLATE NOCASE AND id IS NOT ?",
      householdId,
      name,
      id,
    );
    return same ? `There is already a mailbox called ${same.name}.` : null;
  }

  create(householdId: number, fields: MailboxFields): { problem: string } | { mailbox: MailboxInfo } {
    return this.db.transaction(() => {
      const problem = this.nameTaken(householdId, fields.name, null);
      if (problem) return { problem };
      const slug = this.newSlug(fields.name);
      const stamp = this.now().toISOString();
      const id = this.db.run(
        `INSERT INTO mailboxes (household_id, name, slug, provider, host, port, security, username, password_secret, folder, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        householdId,
        fields.name,
        slug,
        fields.provider,
        fields.host,
        fields.port,
        fields.security,
        fields.username,
        fields.password ? this.box.seal(fields.password, context(slug)) : "",
        fields.folder,
        fields.enabled === false ? 0 : 1,
        stamp,
        stamp,
      ).lastInsertRowid;
      return { mailbox: this.info(this.row(householdId, id)!) };
    });
  }

  update(
    householdId: number,
    id: number,
    fields: MailboxFields,
  ): { missing: true } | { problem: string } | { needsPassword: string } | { mailbox: MailboxInfo } {
    return this.db.transaction(() => {
      const row = this.row(householdId, id);
      if (!row) return { missing: true as const };
      const problem = this.nameTaken(householdId, fields.name, id);
      if (problem) return { problem };
      // A saved password is kept only for the server it was saved for.
      if (!fields.password && row.password_secret !== "" && !sameServer(row, fields)) return { needsPassword: SERVER_CHANGED };
      const secret = fields.password ? this.box.seal(fields.password, context(row.slug)) : row.password_secret;
      this.db.run(
        `UPDATE mailboxes SET name = ?, provider = ?, host = ?, port = ?, security = ?, username = ?, password_secret = ?, folder = ?, enabled = ?, updated_at = ?
         WHERE id = ?`,
        fields.name,
        fields.provider,
        fields.host,
        fields.port,
        fields.security,
        fields.username,
        secret,
        fields.folder,
        fields.enabled === undefined ? row.enabled : fields.enabled ? 1 : 0,
        this.now().toISOString(),
        id,
      );
      return { mailbox: this.info(this.row(householdId, id)!) };
    });
  }

  remove(householdId: number, id: number): boolean {
    return this.db.run("DELETE FROM mailboxes WHERE id = ? AND household_id = ?", id, householdId).changes > 0;
  }

  /**
   * The connection to try for a test: the given password, or that mailbox's
   * saved one, which is only ever sent to the server it was saved for. Null
   * when `id` names no mailbox of the household.
   */
  connectionFor(
    householdId: number,
    fields: z.output<typeof testSchema>,
  ): (MailboxToRead & { savedPasswordProblem: boolean }) | { needsPassword: string } | null {
    let password = fields.password ?? "";
    let savedPasswordProblem = false;
    if (password === "" && fields.id !== undefined) {
      const row = this.row(householdId, fields.id);
      if (!row) return null;
      if (row.password_secret !== "" && !sameServer(row, fields)) return { needsPassword: SERVER_CHANGED };
      const saved = this.password(row);
      savedPasswordProblem = saved === null;
      password = saved ?? "";
    }
    return {
      name: "test",
      slug: "test",
      provider: fields.provider,
      folder: fields.folder,
      imap: { host: fields.host, port: fields.port, security: fields.security, username: fields.username, password },
      savedPasswordProblem,
    };
  }

  private recordCheck(id: number, ok: boolean, message: string, captured: number): void {
    this.db.run(
      "UPDATE mailboxes SET last_checked_at = ?, last_outcome = ?, last_message = ?, last_captured = ? WHERE id = ?",
      this.now().toISOString(),
      ok ? "ok" : "failed",
      message,
      captured,
      id,
    );
  }

  /** Reads every mailbox that is not paused, in every household, and records how each went. */
  async readAll(): Promise<{ read: number; failed: number; captured: number }> {
    const rows = this.db.all<MailboxRow>("SELECT * FROM mailboxes WHERE enabled = 1 ORDER BY household_id, name COLLATE NOCASE, id");
    let read = 0;
    let failed = 0;
    let captured = 0;
    for (const row of rows) {
      const password = this.password(row);
      if (!password) {
        const why = password === null ? KEY_CHANGED : "No password is saved for this mailbox. Add it in Settings.";
        log.error(`"${row.name}": not read: ${why}`);
        this.recordCheck(row.id, false, why, 0);
        failed++;
        continue;
      }
      const mailbox: MailboxToRead = {
        name: row.name,
        slug: row.slug,
        provider: row.provider,
        folder: row.folder,
        imap: { host: row.host, port: row.port, security: row.security, username: row.username, password },
      };
      log.info(`Reading "${row.name}": IMAP ${row.username} at ${row.host}:${row.port} (security ${row.security}), folder ${row.folder}`);
      try {
        const summary = await captureMailbox(mailbox, this.store);
        const notCaptured = summary.failed + summary.tooLarge;
        const message =
          `${summary.captured} new, ${summary.alreadyCaptured} captured before` +
          (summary.failed ? `, ${summary.failed} could not be captured (tried again next time)` : "") +
          (summary.tooLarge ? `, ${summary.tooLarge} too large` : "");
        log.info(`"${row.name}": ${message}`);
        this.recordCheck(row.id, notCaptured === 0, message, summary.captured);
        read++;
        captured += summary.captured;
        if (notCaptured) failed++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`"${row.name}": ${message}`);
        this.recordCheck(row.id, false, message, 0);
        failed++;
      }
    }
    log.info(`Done: ${read} of ${rows.length} mailbox(es) read, ${captured} message(s) captured`);
    return { read, failed, captured };
  }

  /** True once the mailboxes listed in config.yml have been copied in. */
  imported(): boolean {
    return this.db.get("SELECT 1 FROM app_state WHERE key = ?", IMPORTED_KEY) !== undefined;
  }

  /**
   * Copies the mailboxes listed in config.yml (and their passwords from .env)
   * into the first household, once. Before any household exists (a new
   * install) it waits, and is called again after first-time setup. Their
   * slugs are their names' as before, so mail captured earlier stays theirs.
   */
  importFromConfig(config: Config): "copied" | "waiting" | "done before" {
    if (this.imported()) return "done before";
    const household = this.db.get<{ id: number }>("SELECT id FROM households ORDER BY id LIMIT 1");
    if (!household) return "waiting";
    const copied = this.db.transaction(() => {
      if (this.imported()) return null;
      const names: string[] = [];
      const stamp = this.now().toISOString();
      for (const mailbox of config.mailboxes) {
        const slug = mailboxSlug(mailbox.name);
        if (this.db.get("SELECT 1 FROM mailboxes WHERE slug = ?", slug) || this.nameTaken(household.id, mailbox.name, null)) continue;
        const { imap } = mailbox;
        this.db.run(
          `INSERT INTO mailboxes (household_id, name, slug, provider, host, port, security, username, password_secret, folder, enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          household.id,
          mailbox.name,
          slug,
          mailbox.provider,
          imap.host,
          imap.port,
          imap.security,
          imap.username,
          imap.password ? this.box.seal(imap.password, context(slug)) : "",
          mailbox.folder,
          stamp,
          stamp,
        );
        names.push(`"${mailbox.name}" (password ${imap.password ? `from ${imap.passwordEnv}` : `not set: ${imap.passwordEnv} is empty`})`);
      }
      this.db.run("INSERT INTO app_state (key, value) VALUES (?, ?)", IMPORTED_KEY, JSON.stringify({ at: stamp, count: names.length }));
      return names;
    });
    if (copied === null) return "done before";
    log.info(copied.length ? `Copied ${copied.length} mailbox(es) from config.yml into the database: ${copied.join(", ")}` : "No mailboxes in config.yml to copy");
    return "copied";
  }
}

// ---- Routes ------------------------------------------------------------------

export interface MailboxDeps {
  mailboxes: Mailboxes;
  checking: { state(): CheckingState; checkNow(): "started" | "running" | "stopped" };
}

function mailboxId(c: Context): number | null {
  const text = c.req.param("id") ?? "";
  if (!ID.test(text)) return null;
  const id = Number(text);
  return Number.isSafeInteger(id) ? id : null;
}

const isAdmin = (c: Context<AppEnv>) => c.var.user?.isAdmin === true;

/** Tries a connection, with an answer in plain words whatever happens. */
async function runTest(connection: MailboxToRead): Promise<MailboxTestResponse> {
  try {
    const result = await testMailbox(connection);
    if (result.folderProblem) return { ok: false, message: `Signed in, but: ${result.folderProblem}`, folders: result.folders, messages: null };
    const count = result.messages === 1 ? "1 message" : `${result.messages} messages`;
    return { ok: true, message: `Signed in. The folder "${connection.folder}" has ${count}.`, folders: result.folders, messages: result.messages };
  } catch (err) {
    const message = err instanceof MailboxError ? err.message : `Could not connect: ${err instanceof Error ? err.message : String(err)}`;
    return { ok: false, message, folders: [], messages: null };
  }
}

export function mailboxRoutes(deps: MailboxDeps): Hono<AppEnv> {
  const { mailboxes, checking } = deps;
  const app = new Hono<AppEnv>();

  app.get("/mailboxes", (c) => {
    const body: MailboxListResponse = { mailboxes: mailboxes.list(householdOf(c)), checking: checking.state(), canEdit: isAdmin(c) };
    return c.json(body);
  });

  // Before /mailboxes/:id, so "test" and "check" are never read as an id.
  app.post("/mailboxes/test", jsonBody(testSchema), async (c) => {
    if (!isAdmin(c)) return apiError(c, 403, ADMIN_ONLY);
    const connection = mailboxes.connectionFor(householdOf(c), c.req.valid("json"));
    if (!connection) return apiError(c, 404, NOT_FOUND);
    if ("needsPassword" in connection) return apiError(c, 400, connection.needsPassword);
    if (connection.savedPasswordProblem) {
      const body: MailboxTestResponse = { ok: false, message: KEY_CHANGED, folders: [], messages: null };
      return c.json(body);
    }
    return c.json(await runTest(connection));
  });

  app.post("/mailboxes/check", (c) => {
    checking.checkNow();
    return c.json(checking.state());
  });

  app.post("/mailboxes", jsonBody(mailboxSchema), (c) => {
    if (!isAdmin(c)) return apiError(c, 403, ADMIN_ONLY);
    const result = mailboxes.create(householdOf(c), c.req.valid("json"));
    if ("problem" in result) return apiError(c, 409, result.problem);
    return c.json(result.mailbox, 201);
  });

  app.put("/mailboxes/:id", jsonBody(mailboxSchema), (c) => {
    if (!isAdmin(c)) return apiError(c, 403, ADMIN_ONLY);
    const id = mailboxId(c);
    if (id === null) return apiError(c, 404, NOT_FOUND);
    const result = mailboxes.update(householdOf(c), id, c.req.valid("json"));
    if ("missing" in result) return apiError(c, 404, NOT_FOUND);
    if ("needsPassword" in result) return apiError(c, 400, result.needsPassword);
    if ("problem" in result) return apiError(c, 409, result.problem);
    return c.json(result.mailbox);
  });

  app.delete("/mailboxes/:id", (c) => {
    if (!isAdmin(c)) return apiError(c, 403, ADMIN_ONLY);
    const id = mailboxId(c);
    if (id === null || !mailboxes.remove(householdOf(c), id)) return apiError(c, 404, NOT_FOUND);
    return c.body(null, 204);
  });

  return app;
}
