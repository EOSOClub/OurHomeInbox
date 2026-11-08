// The household's mailboxes: where its bills are read from.
//   GET    /api/mailboxes        the household's mailboxes and when mail is read
//   POST   /api/mailboxes        add one
//   PUT    /api/mailboxes/:id    change one; a password left out keeps the saved one
//   DELETE /api/mailboxes/:id    remove one; its captured mail stays on disk
//   POST   /api/mailboxes/:id/restore  bring a removed one back with its mail
//   POST   /api/mailboxes/test   try settings before saving them
//   POST   /api/mailboxes/check  read every mailbox now
//
// Everyone in the household can change its mailboxes (owner, 2026-11-01:
// managing the household's money is a shared effort).
//
// Mailboxes are kept in the database, per household, with their passwords
// encrypted (secrets.ts); a password is never sent back, only whether one is
// saved, and a saved one is only ever sent to the server it was saved for:
// changing the server, port, security or username needs it typed again. Each mailbox's captured mail sits under data/mail/<slug>: the slug is
// unique across the install and kept when the mailbox is renamed.
//
// A mailbox reads one or more folders over one sign-in (owner, 2026-11-04).
// Each folder keeps its mail under its own slug (mailbox_folders), so two
// folders' message numbers never meet; the first folder a mailbox gets uses
// the mailbox's own slug. A folder taken off the list is kept, marked
// removed: its emails stay shown with the mailbox, and listing it again
// picks up where it left off.
//
// A mailbox can also list folders or labels to leave out (owner, 2026-11-05,
// mailbox_skip_folders): an email also in one of them is not captured (see
// mailbox.ts). A folder cannot be both read and left out.
//
// A removed mailbox is kept, marked removed and without its password, so it
// can be restored with its mail; until then it is not read and its mail is
// not shown. Its name stays taken, so adding it again by hand (which would
// start a new, empty folder) points to restoring it instead.
//
// Only an admin may add or change mailboxes for now; household roles come
// with adding people. Another household's mailbox is "not found".

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Config } from "../config.js";
import { mailboxSlug } from "../config.js";
import { log } from "../log.js";
import { captureMailbox, MailboxError, testMailbox, type CaptureSummary, type FolderRead, type MailboxTest, type MailboxToRead } from "../mailbox.js";
import type { CheckingState, MailboxInfo, MailboxListResponse, MailboxTestResponse, RemovedMailbox } from "../shared/api.js";
import { folderPath } from "../shared/folders.js";
import {
  MAX_MAILBOX_FOLDER,
  MAX_MAILBOX_FOLDERS,
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
const KEY_CHANGED = "The saved password can no longer be read: the key that protects saved passwords has changed. Enter the password again.";
const IMPORTED_KEY = "config_mailboxes_imported";
const LOST_FOLDERS_KEY = "lost_mail_folders_checked";
const ID = /^[1-9]\d*$/;
const IN_USE = "removed_at IS NULL";

/** How many emails are captured in a mailbox's folder under data/mail. */
function capturedEmails(root: string, slug: string): number {
  let count = 0;
  for (const validity of subfolders(join(root, slug))) {
    for (const uid of subfolders(join(root, slug, validity))) {
      if (existsSync(join(root, slug, validity, uid, "capture.json"))) count++;
    }
  }
  return count;
}

/** The folders in `dir`, or none when it does not exist. */
function subfolders(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** The mailbox name and folder recorded in the first email captured in `dir`, if any. */
function recordedMailbox(dir: string): { name: string; folder: string } | null {
  for (const validity of subfolders(dir)) {
    for (const uid of subfolders(join(dir, validity))) {
      try {
        const capture = JSON.parse(readFileSync(join(dir, validity, uid, "capture.json"), "utf8")) as { mailbox?: unknown; folder?: unknown };
        return {
          name: typeof capture.mailbox === "string" ? capture.mailbox.trim().slice(0, MAX_MAILBOX_NAME) : "",
          folder: typeof capture.folder === "string" ? capture.folder.trim().slice(0, MAX_MAILBOX_FOLDER) : "",
        };
      } catch {
        // Not captured completely; try the next.
      }
    }
  }
  return null;
}

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
  enabled: number;
  last_checked_at: string | null;
  last_outcome: string | null;
  last_message: string | null;
  last_captured: number | null;
  last_ok_at: string | null;
  failing_since: string | null;
  removed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface FolderRow {
  id: number;
  mailbox_id: number;
  folder: string;
  slug: string;
  position: number;
  removed_at: string | null;
  created_at: string;
}

/** Settings to try before saving them. */
type TestConnection = Pick<MailboxToRead, "provider" | "imap"> & { folders: string[]; skipFolders: string[]; savedPasswordProblem: boolean };

/** One folder's read in words: "2 new, 10 captured before", or why it could not be read. */
function readLine(read: FolderRead): string {
  if ("problem" in read) return read.problem;
  const { summary } = read;
  return (
    `${summary.captured} new, ${summary.alreadyCaptured} captured before` +
    (summary.failed ? `, ${summary.failed} could not be captured (tried again next time)` : "") +
    (summary.tooLarge ? `, ${summary.tooLarge} too large` : "") +
    (summary.leftOut ? `, ${summary.leftOut} left out` : "")
  );
}

/** Messages a read left behind: failed or too large. */
const leftBehind = (summary: CaptureSummary) => summary.failed + summary.tooLarge;

/** The folders a mailbox reads, in order. */
const listedFolders = (folders: FolderRow[]) => folders.filter((f) => f.removed_at === null).map((f) => f.folder);

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

/** The folders to read. A test may have none yet: it lists the mailbox's folders to choose from. */
const folderList = z
  .array(
    z
      .string({ error: "Enter the folder to read." })
      .trim()
      .min(1, "Enter the folder to read, like INBOX or Folders/Bills.")
      .max(MAX_MAILBOX_FOLDER, "That folder name is too long."),
    { error: "Add a folder to read, like INBOX or Folders/Bills." },
  )
  .max(MAX_MAILBOX_FOLDERS, `A mailbox can read up to ${MAX_MAILBOX_FOLDERS} folders.`);

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
  folders: folderList.min(1, "Add a folder to read, like INBOX or Folders/Bills."),
  skipFolders: z
    .array(
      z
        .string({ error: "Enter the folder to leave out." })
        .trim()
        .min(1, "Enter the folder to leave out, like Labels/Skip.")
        .max(MAX_MAILBOX_FOLDER, "That folder name is too long."),
      { error: MESSAGES.badShape },
    )
    .max(MAX_MAILBOX_FOLDERS, `A mailbox can leave out up to ${MAX_MAILBOX_FOLDERS} folders.`)
    .optional(),
};

/**
 * Each folder as it is read (see shared/folders.ts: for Proton Mail Bridge,
 * "Finance/Bills" is "Folders/Finance/Bills"), checked again after that, and
 * each listed once.
 */
function withFolderPaths<T extends { provider: Provider; folders: string[]; skipFolders?: string[] | undefined }>(
  fields: T,
  ctx: { addIssue: (issue: { code: "custom"; message: string; path: string[] }) => void },
): T {
  const folders = fields.folders.map((folder) => folderPath(fields.provider, folder));
  const skipFolders = fields.skipFolders?.map((folder) => folderPath(fields.provider, folder));
  const listProblem = (list: string[], empty: string) =>
    list.includes("")
      ? empty
      : list.some((folder) => folder.length > MAX_MAILBOX_FOLDER)
        ? "That folder name is too long."
        : new Set(list).size !== list.length
          ? "Each folder can only be listed once."
          : null;
  const problem = listProblem(folders, "Enter the folder to read, like INBOX or Folders/Bills.");
  if (problem) {
    ctx.addIssue({ code: "custom", message: problem, path: ["folders"] });
    return z.NEVER;
  }
  if (skipFolders) {
    const both = skipFolders.find((folder) => folders.includes(folder));
    const skipProblem =
      listProblem(skipFolders, "Enter the folder to leave out, like Labels/Skip.") ??
      (both === undefined ? null : `"${both}" is read by this mailbox, so it cannot also be left out.`);
    if (skipProblem) {
      ctx.addIssue({ code: "custom", message: skipProblem, path: ["skipFolders"] });
      return z.NEVER;
    }
  }
  return { ...fields, folders, ...(skipFolders ? { skipFolders } : {}) };
}

const mailboxSchema = z
  .object(
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
  )
  .transform(withFolderPaths);

const testSchema = z
  .object({ id: z.number().int().positive().optional(), ...connectionFields, folders: folderList }, { error: MESSAGES.badShape })
  .transform(withFolderPaths);

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
    return this.db.all<MailboxRow>(`SELECT * FROM mailboxes WHERE household_id = ? AND ${IN_USE} ORDER BY name COLLATE NOCASE, id`, householdId);
  }

  private row(householdId: number, id: number): MailboxRow | undefined {
    return this.db.get<MailboxRow>(`SELECT * FROM mailboxes WHERE id = ? AND household_id = ? AND ${IN_USE}`, id, householdId);
  }

  private removedRow(householdId: number, id: number): MailboxRow | undefined {
    return this.db.get<MailboxRow>("SELECT * FROM mailboxes WHERE id = ? AND household_id = ? AND removed_at IS NOT NULL", id, householdId);
  }

  /** A mailbox's folders, the ones it reads first (in order), then the ones taken off its list. */
  private folderRows(mailboxId: number): FolderRow[] {
    return this.db.all<FolderRow>("SELECT * FROM mailbox_folders WHERE mailbox_id = ? ORDER BY removed_at IS NOT NULL, position, id", mailboxId);
  }

  /** Every slug a mailbox's mail is kept under: its own, and each of its folders'. */
  private slugsOf(row: MailboxRow): string[] {
    return [...new Set([row.slug, ...this.folderRows(row.id).map((f) => f.slug)])];
  }

  /**
   * Makes the mailbox read exactly `folders`, in that order. A folder it had
   * before keeps its slug, so its mail is not captured again; a new one gets
   * the mailbox's own slug if no folder has it yet, else one of its own. A
   * folder left out is marked removed, not deleted, and its mail stays shown.
   */
  private setFolders(row: Pick<MailboxRow, "id" | "slug">, folders: string[]): void {
    const stamp = this.now().toISOString();
    const existing = this.folderRows(row.id);
    folders.forEach((folder, position) => {
      const found = existing.find((f) => f.folder === folder);
      if (found) {
        this.db.run("UPDATE mailbox_folders SET position = ?, removed_at = NULL WHERE id = ?", position, found.id);
        return;
      }
      const ownSlugFree = !existing.some((f) => f.slug === row.slug) && !this.db.get("SELECT 1 FROM mailbox_folders WHERE slug = ?", row.slug);
      const slug = ownSlugFree ? row.slug : this.newSlug(`${row.slug} ${folder}`);
      const id = this.db.run(
        "INSERT INTO mailbox_folders (mailbox_id, folder, slug, position, created_at) VALUES (?, ?, ?, ?, ?)",
        row.id,
        folder,
        slug,
        position,
        stamp,
      ).lastInsertRowid;
      existing.push({ id, mailbox_id: row.id, folder, slug, position, removed_at: null, created_at: stamp });
    });
    for (const f of existing) {
      if (f.removed_at === null && !folders.includes(f.folder)) this.db.run("UPDATE mailbox_folders SET removed_at = ? WHERE id = ?", stamp, f.id);
    }
  }

  /** The folders a mailbox leaves out, in the order they were listed. */
  private skipFolderList(mailboxId: number): string[] {
    return this.db.all<{ folder: string }>("SELECT folder FROM mailbox_skip_folders WHERE mailbox_id = ? ORDER BY position, folder", mailboxId).map((r) => r.folder);
  }

  /** Makes the mailbox leave out exactly `folders`. Nothing is captured or removed by it: it only decides what later reads take. */
  private setSkipFolders(mailboxId: number, folders: readonly string[]): void {
    this.db.run("DELETE FROM mailbox_skip_folders WHERE mailbox_id = ?", mailboxId);
    folders.forEach((folder, position) => this.db.run("INSERT INTO mailbox_skip_folders (mailbox_id, folder, position) VALUES (?, ?, ?)", mailboxId, folder, position));
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
      folders: listedFolders(this.folderRows(row.id)),
      skipFolders: this.skipFolderList(row.id),
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
      lastOkAt: row.last_ok_at,
      failingSince: row.failing_since,
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

  /**
   * Where the household's mail is kept, by slug, for finding and listing it:
   * each mailbox's own slug and each of its folders', including folders taken
   * off its list. Paused mailboxes included: their mail stays visible.
   */
  places(householdId: number): Map<string, MailboxPlace> {
    const places = new Map<string, MailboxPlace>();
    for (const row of this.rows(householdId)) {
      const folders = this.folderRows(row.id);
      const own = folders.find((f) => f.slug === row.slug);
      places.set(row.slug, { slug: row.slug, name: row.name, folder: own?.folder ?? folders[0]?.folder ?? "" });
      for (const f of folders) if (!places.has(f.slug)) places.set(f.slug, { slug: f.slug, name: row.name, folder: f.folder });
    }
    return places;
  }

  households(): number[] {
    return this.db
      .all<{ household_id: number }>(`SELECT DISTINCT household_id FROM mailboxes WHERE ${IN_USE} ORDER BY household_id`)
      .map((r) => r.household_id);
  }

  /** The household's removed mailboxes, with how many captured emails each would bring back. */
  removed(householdId: number): RemovedMailbox[] {
    return this.db
      .all<MailboxRow>("SELECT * FROM mailboxes WHERE household_id = ? AND removed_at IS NOT NULL ORDER BY name COLLATE NOCASE, id", householdId)
      .map((row) => ({
        id: row.id,
        name: row.name,
        slug: row.slug,
        provider: row.provider,
        folders: listedFolders(this.folderRows(row.id)),
        skipFolders: this.skipFolderList(row.id),
        // Unknown for a mailbox found on disk (see findLostFolders).
        imap: row.host === "" ? null : { host: row.host, port: row.port, security: row.security, username: row.username },
        emails: this.slugsOf(row).reduce((sum, slug) => sum + capturedEmails(this.store.root, slug), 0),
        removedAt: row.removed_at!,
      }));
  }

  /** True when a slug is a mailbox's or a folder's. */
  private slugInUse(slug: string): boolean {
    return (
      this.db.get("SELECT 1 FROM mailboxes WHERE slug = ?", slug) !== undefined ||
      this.db.get("SELECT 1 FROM mailbox_folders WHERE slug = ?", slug) !== undefined
    );
  }

  /** A slug for a new mailbox or folder: from `text`, made unique across the install and against folders already on disk. */
  private newSlug(text: string): string {
    const base = mailboxSlug(text);
    for (let n = 1; ; n++) {
      const slug = n === 1 ? base : `${base.slice(0, 55)}-${n}`;
      if (!this.slugInUse(slug) && !existsSync(join(this.store.root, slug))) return slug;
    }
  }

  /** Removed mailboxes keep their names, so adding one again by hand points to restoring it, with its mail. */
  private nameTaken(householdId: number, name: string, id: number | null): string | null {
    const same = this.db.get<{ name: string; removed_at: string | null }>(
      "SELECT name, removed_at FROM mailboxes WHERE household_id = ? AND name = ? COLLATE NOCASE AND id IS NOT ?",
      householdId,
      name,
      id,
    );
    if (!same) return null;
    return same.removed_at === null
      ? `There is already a mailbox called ${same.name}.`
      : `A removed mailbox is called ${same.name}. Restore it under Removed mailboxes in Settings to get its emails back, or choose another name.`;
  }

  create(householdId: number, fields: MailboxFields): { problem: string } | { mailbox: MailboxInfo } {
    return this.db.transaction(() => {
      const problem = this.nameTaken(householdId, fields.name, null);
      if (problem) return { problem };
      const slug = this.newSlug(fields.name);
      const stamp = this.now().toISOString();
      const id = this.db.run(
        `INSERT INTO mailboxes (household_id, name, slug, provider, host, port, security, username, password_secret, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        householdId,
        fields.name,
        slug,
        fields.provider,
        fields.host,
        fields.port,
        fields.security,
        fields.username,
        fields.password ? this.box.seal(fields.password, context(slug)) : "",
        fields.enabled === false ? 0 : 1,
        stamp,
        stamp,
      ).lastInsertRowid;
      this.setFolders({ id, slug }, fields.folders);
      this.setSkipFolders(id, fields.skipFolders ?? []);
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
        `UPDATE mailboxes SET name = ?, provider = ?, host = ?, port = ?, security = ?, username = ?, password_secret = ?, enabled = ?, updated_at = ?
         WHERE id = ?`,
        fields.name,
        fields.provider,
        fields.host,
        fields.port,
        fields.security,
        fields.username,
        secret,
        fields.enabled === undefined ? row.enabled : fields.enabled ? 1 : 0,
        this.now().toISOString(),
        id,
      );
      this.setFolders(row, fields.folders);
      // Left out of the request: the saved ones stay. A saved one now read is no longer left out.
      const skip = fields.skipFolders ?? this.skipFolderList(id).filter((folder) => !fields.folders.includes(folder));
      this.setSkipFolders(id, skip);
      return { mailbox: this.info(this.row(householdId, id)!) };
    });
  }

  /** Marks one removed: no longer read or shown, and its password forgotten. Its mail stays on disk for restoring. */
  remove(householdId: number, id: number): boolean {
    const stamp = this.now().toISOString();
    return (
      this.db.run(
        `UPDATE mailboxes SET removed_at = ?, updated_at = ?, enabled = 0, password_secret = '', failing_since = NULL
         WHERE id = ? AND household_id = ? AND ${IN_USE}`,
        stamp,
        stamp,
        id,
        householdId,
      ).changes > 0
    );
  }

  /**
   * Brings a removed mailbox back with its mail, using the settings given,
   * as when adding one: its password was not kept, so only one typed now is
   * used. It keeps its slug, so the emails captured before are its own again
   * and are not captured a second time.
   */
  restore(householdId: number, id: number, fields: MailboxFields): { missing: true } | { problem: string } | { mailbox: MailboxInfo } {
    return this.db.transaction(() => {
      const row = this.removedRow(householdId, id);
      if (!row) return { missing: true as const };
      const problem = this.nameTaken(householdId, fields.name, id);
      if (problem) return { problem };
      this.db.run(
        `UPDATE mailboxes SET name = ?, provider = ?, host = ?, port = ?, security = ?, username = ?, password_secret = ?, enabled = ?,
           removed_at = NULL, failing_since = NULL, updated_at = ?
         WHERE id = ?`,
        fields.name,
        fields.provider,
        fields.host,
        fields.port,
        fields.security,
        fields.username,
        fields.password ? this.box.seal(fields.password, context(row.slug)) : "",
        fields.enabled === false ? 0 : 1,
        this.now().toISOString(),
        id,
      );
      this.setFolders(row, fields.folders);
      this.setSkipFolders(id, fields.skipFolders ?? []);
      return { mailbox: this.info(this.row(householdId, id)!) };
    });
  }

  /**
   * The connection to try for a test: the given password, or that mailbox's
   * saved one, which is only ever sent to the server it was saved for. Null
   * when `id` names no mailbox of the household.
   */
  connectionFor(householdId: number, fields: z.output<typeof testSchema>): TestConnection | { needsPassword: string } | null {
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
      provider: fields.provider,
      folders: fields.folders,
      skipFolders: fields.skipFolders ?? [],
      imap: { host: fields.host, port: fields.port, security: fields.security, username: fields.username, password },
      savedPasswordProblem,
    };
  }

  /** Saves how a read went. A good read clears "failing since"; a failed one keeps the first failure's time. */
  private recordCheck(id: number, ok: boolean, message: string, captured: number): void {
    const stamp = this.now().toISOString();
    this.db.run(
      `UPDATE mailboxes SET last_checked_at = ?, last_outcome = ?, last_message = ?, last_captured = ?,
         last_ok_at = CASE WHEN ? THEN ? ELSE last_ok_at END,
         failing_since = CASE WHEN ? THEN NULL ELSE COALESCE(failing_since, ?) END
       WHERE id = ?`,
      stamp,
      ok ? "ok" : "failed",
      message,
      captured,
      ok ? 1 : 0,
      stamp,
      ok ? 1 : 0,
      stamp,
      id,
    );
  }

  /** Reads every mailbox that is not paused, in every household, and records how each went. */
  async readAll(): Promise<{ read: number; failed: number; captured: number }> {
    const rows = this.db.all<MailboxRow>(`SELECT * FROM mailboxes WHERE enabled = 1 AND ${IN_USE} ORDER BY household_id, name COLLATE NOCASE, id`);
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
      const folders = this.folderRows(row.id)
        .filter((f) => f.removed_at === null)
        .map((f) => ({ folder: f.folder, slug: f.slug }));
      if (folders.length === 0) {
        const why = "No folder is set for this mailbox. Add one in Settings.";
        log.error(`"${row.name}": not read: ${why}`);
        this.recordCheck(row.id, false, why, 0);
        failed++;
        continue;
      }
      const skipFolders = this.skipFolderList(row.id);
      const mailbox: MailboxToRead = {
        name: row.name,
        provider: row.provider,
        folders,
        skipFolders,
        imap: { host: row.host, port: row.port, security: row.security, username: row.username, password },
      };
      const folderList = folders.map((f) => f.folder).join(", ");
      log.info(
        `Reading "${row.name}": IMAP ${row.username} at ${row.host}:${row.port} (security ${row.security}), folder${folders.length === 1 ? "" : "s"} ${folderList}` +
          (skipFolders.length ? `, leaving out emails also in ${skipFolders.join(", ")}` : ""),
      );
      try {
        const reads = await captureMailbox(mailbox, this.store);
        // One folder reads as before; with several, each says which it is.
        const message = reads.length === 1 ? readLine(reads[0]!) : reads.map((r) => `${r.folder}: ${readLine(r)}`).join("; ");
        const problems = reads.filter((r) => "problem" in r).length;
        const notCaptured = reads.reduce((sum, r) => sum + ("summary" in r ? leftBehind(r.summary) : 0), 0);
        const newOnes = reads.reduce((sum, r) => sum + ("summary" in r ? r.summary.captured : 0), 0);
        if (problems === 0) log.info(`"${row.name}": ${message}`);
        else log.error(`"${row.name}": ${message}`);
        this.recordCheck(row.id, problems === 0 && notCaptured === 0, message, newOnes);
        if (problems === 0) read++;
        captured += newOnes;
        if (problems > 0 || notCaptured > 0) failed++;
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
        if (this.slugInUse(slug) || this.nameTaken(household.id, mailbox.name, null)) continue;
        const { imap } = mailbox;
        const id = this.db.run(
          `INSERT INTO mailboxes (household_id, name, slug, provider, host, port, security, username, password_secret, enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          household.id,
          mailbox.name,
          slug,
          mailbox.provider,
          imap.host,
          imap.port,
          imap.security,
          imap.username,
          imap.password ? this.box.seal(imap.password, context(slug)) : "",
          stamp,
          stamp,
        ).lastInsertRowid;
        // As typed on the web: "Finance/Bills" is read as "Folders/Finance/Bills" on the Bridge.
        const folder = folderPath(mailbox.provider, mailbox.folder);
        this.setFolders({ id, slug }, folder ? [folder] : []);
        names.push(`"${mailbox.name}" (password ${imap.password ? `from ${imap.passwordEnv}` : `not set: ${imap.passwordEnv} is empty`})`);
      }
      this.db.run("INSERT INTO app_state (key, value) VALUES (?, ?)", IMPORTED_KEY, JSON.stringify({ at: stamp, count: names.length }));
      return names;
    });
    if (copied === null) return "done before";
    log.info(copied.length ? `Copied ${copied.length} mailbox(es) from config.yml into the database: ${copied.join(", ")}` : "No mailboxes in config.yml to copy");
    return "copied";
  }

  /**
   * Once, after the copy from config.yml: finds folders of captured mail in
   * data/mail that no mailbox owns, left by mailboxes removed before removed
   * ones were kept (they were deleted outright), and lists each as a removed
   * mailbox so it can be restored with its mail. Its name and folder come
   * from its emails; its server and login were not kept. A folder does not
   * say whose it is, so this is only done on an install with one household;
   * with more, they stay hidden and the log says so.
   */
  findLostFolders(): "found" | "waiting" | "done before" {
    if (this.db.get("SELECT 1 FROM app_state WHERE key = ?", LOST_FOLDERS_KEY)) return "done before";
    const households = this.db.all<{ id: number }>("SELECT id FROM households ORDER BY id");
    if (households.length === 0) return "waiting";
    const found = this.db.transaction(() => {
      if (this.db.get("SELECT 1 FROM app_state WHERE key = ?", LOST_FOLDERS_KEY)) return null;
      const lost = subfolders(this.store.root).filter(
        (slug) => mailboxSlug(slug) === slug && !this.slugInUse(slug) && capturedEmails(this.store.root, slug) > 0,
      );
      const names: string[] = [];
      const household = households.length === 1 ? households[0]!.id : null;
      const stamp = this.now().toISOString();
      for (const slug of household === null ? [] : lost) {
        const recorded = recordedMailbox(join(this.store.root, slug));
        const base = recorded && mailboxSlug(recorded.name) !== "" ? recorded.name : slug;
        let name = base;
        for (let n = 1; this.nameTaken(household!, name, null); n++) name = `${base.slice(0, MAX_MAILBOX_NAME - 12)} (found${n === 1 ? "" : ` ${n}`})`;
        const id = this.db.run(
          `INSERT INTO mailboxes (household_id, name, slug, provider, host, port, security, username, password_secret, enabled, removed_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, '', 0, 'none', '', '', 0, ?, ?, ?)`,
          household,
          name,
          slug,
          PROVIDERS[0],
          stamp,
          stamp,
          stamp,
        ).lastInsertRowid;
        // Its emails name the folder they came from, offered when it is restored.
        if (recorded?.folder) this.setFolders({ id, slug }, [recorded.folder]);
        names.push(`"${name}" (${capturedEmails(this.store.root, slug)} emails in ${slug})`);
      }
      this.db.run("INSERT INTO app_state (key, value) VALUES (?, ?)", LOST_FOLDERS_KEY, JSON.stringify({ at: stamp, found: names.length }));
      return { names, hidden: household === null ? lost : [] };
    });
    if (found === null) return "done before";
    if (found.names.length) log.info(`Found ${found.names.length} removed mailbox(es) on disk, listed in Settings to restore: ${found.names.join(", ")}`);
    if (found.hidden.length)
      log.warn(`${found.hidden.length} folder(s) of mail in data/mail belong to no mailbox, and with more than one household it is not known whose they are: ${found.hidden.join(", ")}`);
    return "found";
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

const messageCount = (n: number) => (n === 1 ? "1 message" : `${n} messages`);

/**
 * A test's answer in plain words: each chosen folder's count, or why one could
 * not be found. With no folders to read chosen yet (a new mailbox), how many
 * there are to choose from.
 */
export function testAnswer({ folders, checked }: MailboxTest): MailboxTestResponse {
  const problems = checked.flatMap((c) => ("problem" in c ? [c.problem] : []));
  if (problems.length > 0) return { ok: false, message: `Signed in, but: ${problems.join(" ")}`, folders };
  const counts = checked.map((c) => `"${c.folder}"${c.leftOut ? " (left out)" : ""} has ${messageCount("messages" in c ? c.messages : 0)}`);
  const choose = checked.some((c) => !c.leftOut)
    ? ""
    : folders.length === 0
      ? " No folders were found in this mailbox."
      : ` Found ${folders.length === 1 ? "1 folder" : `${folders.length} folders`}: choose the ones to read.`;
  const message =
    counts.length === 0 ? `Signed in.${choose}` : counts.length === 1 ? `Signed in. The folder ${counts[0]}.${choose}` : `Signed in. ${counts.join(", ")}.${choose}`;
  return { ok: true, message, folders };
}

/** Tries a connection, with an answer in plain words whatever happens. */
async function runTest(connection: TestConnection): Promise<MailboxTestResponse> {
  try {
    return testAnswer(await testMailbox(connection));
  } catch (err) {
    const message = err instanceof MailboxError ? err.message : `Could not connect: ${err instanceof Error ? err.message : String(err)}`;
    return { ok: false, message, folders: [] };
  }
}

export function mailboxRoutes(deps: MailboxDeps): Hono<AppEnv> {
  const { mailboxes, checking } = deps;
  const app = new Hono<AppEnv>();

  app.get("/mailboxes", (c) => {
    const body: MailboxListResponse = {
      mailboxes: mailboxes.list(householdOf(c)),
      removed: mailboxes.removed(householdOf(c)),
      checking: checking.state(),
      // Everyone signed in; kept in the reply so the page can still show a read-only view if that ever changes.
      canEdit: true,
    };
    return c.json(body);
  });

  // Before /mailboxes/:id, so "test" and "check" are never read as an id.
  app.post("/mailboxes/test", jsonBody(testSchema), async (c) => {
    const connection = mailboxes.connectionFor(householdOf(c), c.req.valid("json"));
    if (!connection) return apiError(c, 404, NOT_FOUND);
    if ("needsPassword" in connection) return apiError(c, 400, connection.needsPassword);
    if (connection.savedPasswordProblem) {
      const body: MailboxTestResponse = { ok: false, message: KEY_CHANGED, folders: [] };
      return c.json(body);
    }
    return c.json(await runTest(connection));
  });

  app.post("/mailboxes/check", (c) => {
    checking.checkNow();
    return c.json(checking.state());
  });

  app.post("/mailboxes", jsonBody(mailboxSchema), (c) => {
    const result = mailboxes.create(householdOf(c), c.req.valid("json"));
    if ("problem" in result) return apiError(c, 409, result.problem);
    return c.json(result.mailbox, 201);
  });

  app.put("/mailboxes/:id", jsonBody(mailboxSchema), (c) => {
    const id = mailboxId(c);
    if (id === null) return apiError(c, 404, NOT_FOUND);
    const result = mailboxes.update(householdOf(c), id, c.req.valid("json"));
    if ("missing" in result) return apiError(c, 404, NOT_FOUND);
    if ("needsPassword" in result) return apiError(c, 400, result.needsPassword);
    if ("problem" in result) return apiError(c, 409, result.problem);
    return c.json(result.mailbox);
  });

  app.delete("/mailboxes/:id", (c) => {
    const id = mailboxId(c);
    if (id === null || !mailboxes.remove(householdOf(c), id)) return apiError(c, 404, NOT_FOUND);
    return c.body(null, 204);
  });

  app.post("/mailboxes/:id/restore", jsonBody(mailboxSchema), (c) => {
    const id = mailboxId(c);
    if (id === null) return apiError(c, 404, NOT_FOUND);
    const result = mailboxes.restore(householdOf(c), id, c.req.valid("json"));
    if ("missing" in result) return apiError(c, 404, NOT_FOUND);
    if ("problem" in result) return apiError(c, 409, result.problem);
    return c.json(result.mailbox);
  });

  return app;
}
