// The server's own database: households, accounts, sign-in sessions and each
// household's mailboxes, billers and their rules, tags and reviews, in one SQLite file next to the captured mail. Captured
// mail itself stays as files (see store.ts).
//
// The schema changes through MIGRATIONS only, in order, never edited once
// released. PRAGMA user_version records how many have run.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

export type SqlValue = SQLInputValue;

// Each entry moves the schema up one version: MIGRATIONS[0] makes version 1.
// Everything is household-scoped from the start, even though v1 has only the
// one household made at first-time setup. Exported for testing a migration
// against a database made by an older version.
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE households (
    id integer PRIMARY KEY,
    name text NOT NULL,
    created_at text NOT NULL
  );
  CREATE TABLE users (
    id integer PRIMARY KEY,
    household_id integer NOT NULL REFERENCES households(id),
    email text NOT NULL UNIQUE COLLATE NOCASE,
    name text NOT NULL,
    password_hash text NOT NULL,
    is_admin integer NOT NULL DEFAULT 0,
    created_at text NOT NULL
  );
  CREATE INDEX users_household ON users(household_id);
  CREATE TABLE sessions (
    token_hash text PRIMARY KEY,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at text NOT NULL,
    expires_at text NOT NULL,
    last_seen_at text NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE INDEX sessions_expires ON sessions(expires_at);
  `,
  // Billers and the addresses their emails come from. A sender belongs to one
  // biller per household, so an email never matches two.
  `
  CREATE TABLE billers (
    id integer PRIMARY KEY,
    household_id integer NOT NULL REFERENCES households(id),
    name text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('bill', 'subscription')),
    notes text NOT NULL DEFAULT '',
    created_at text NOT NULL,
    updated_at text NOT NULL
  );
  CREATE UNIQUE INDEX billers_household_name ON billers(household_id, name COLLATE NOCASE);
  CREATE TABLE biller_senders (
    biller_id integer NOT NULL REFERENCES billers(id) ON DELETE CASCADE,
    household_id integer NOT NULL REFERENCES households(id),
    sender text NOT NULL,
    position integer NOT NULL,
    PRIMARY KEY (biller_id, sender)
  );
  CREATE UNIQUE INDEX biller_senders_household ON biller_senders(household_id, sender);
  `,
  // Biller rules, saved with Fix: in this biller's emails, the field is the
  // value after this label. One per field. The field is checked in code, so a
  // new field needs no migration.
  `
  CREATE TABLE biller_rules (
    biller_id integer NOT NULL REFERENCES billers(id) ON DELETE CASCADE,
    household_id integer NOT NULL REFERENCES households(id),
    field text NOT NULL,
    label text NOT NULL,
    created_at text NOT NULL,
    PRIMARY KEY (biller_id, field)
  );
  CREATE INDEX biller_rules_household ON biller_rules(household_id);
  `,
  // Whether to get the invoice behind a biller's "View Invoice" links (see
  // invoices.ts). On unless the household turns it off.
  `
  ALTER TABLE billers ADD COLUMN fetch_invoices integer NOT NULL DEFAULT 1;
  `,
  // Mailboxes, per household (see mailboxes.ts). The slug is the mailbox's
  // folder under data/mail: unique across the install, and kept when the
  // mailbox is renamed so its mail never moves. The password is encrypted
  // (secrets.ts); '' means none is saved. The last_* columns say how the last
  // read went. app_state remembers one-time jobs, such as copying the
  // mailboxes from config.yml.
  `
  CREATE TABLE mailboxes (
    id integer PRIMARY KEY,
    household_id integer NOT NULL REFERENCES households(id),
    name text NOT NULL,
    slug text NOT NULL UNIQUE,
    provider text NOT NULL,
    host text NOT NULL,
    port integer NOT NULL,
    security text NOT NULL,
    username text NOT NULL,
    password_secret text NOT NULL DEFAULT '',
    folder text NOT NULL,
    enabled integer NOT NULL DEFAULT 1,
    last_checked_at text,
    last_outcome text,
    last_message text,
    last_captured integer,
    created_at text NOT NULL,
    updated_at text NOT NULL
  );
  CREATE UNIQUE INDEX mailboxes_household_name ON mailboxes(household_id, name COLLATE NOCASE);
  CREATE TABLE app_state (
    key text PRIMARY KEY,
    value text NOT NULL
  );
  `,
  // For the Status page: when a mailbox was last read without a problem, and
  // since when it has failed every time (cleared by a good read).
  `
  ALTER TABLE mailboxes ADD COLUMN last_ok_at text;
  ALTER TABLE mailboxes ADD COLUMN failing_since text;
  `,
  // A removed mailbox is kept, without its password, so it can be restored
  // with its captured mail (its slug stays taken). NULL while it is in use.
  `
  ALTER TABLE mailboxes ADD COLUMN removed_at text;
  `,
  // Tags, per household (see tags.ts). name_key is the name in lower case
  // (shared/tags.ts tagKey), so "Été" and "été" are one tag, which NOCASE
  // alone would not catch. An email is named by its capture id
  // ("<slug>/<uidValidity>/<uid>"), which never changes: the slug is kept
  // through a rename and a restore.
  `
  CREATE TABLE tags (
    id integer PRIMARY KEY,
    household_id integer NOT NULL REFERENCES households(id),
    name text NOT NULL,
    name_key text NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL
  );
  CREATE UNIQUE INDEX tags_household_name ON tags(household_id, name_key);
  CREATE TABLE capture_tags (
    tag_id integer NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    household_id integer NOT NULL REFERENCES households(id),
    capture_id text NOT NULL,
    created_at text NOT NULL,
    PRIMARY KEY (tag_id, capture_id)
  );
  CREATE INDEX capture_tags_capture ON capture_tags(household_id, capture_id);
  `,
  // Review (see reviews.ts): a person marked the email checked or not a bill.
  // No row means it still needs a look. Named by capture id, as tags are.
  `
  CREATE TABLE capture_reviews (
    household_id integer NOT NULL REFERENCES households(id),
    capture_id text NOT NULL,
    state text NOT NULL CHECK (state IN ('checked', 'not-bill')),
    reviewed_by integer REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at text NOT NULL,
    PRIMARY KEY (household_id, capture_id)
  );
  `,
  // The hand-off to OurHome (see handoff/routes.ts and the vault's "Hand-off" note).
  // - handoff_connections: a household's token for OurHome (only its SHA-256;
  //   NULL once revoked), the start date, and how far OurHome has read.
  // - handoff_offers: what was last offered to OurHome about each email, with
  //   a number that rises with every offer, so OurHome asks for what changed.
  // - billers.auto_send: Send automatically, earned by Checked emails.
  // - biller_clean_checks: the biller's current run of Checked emails that
  //   needed no fix; emptied when the run breaks.
  `
  CREATE TABLE handoff_connections (
    household_id integer PRIMARY KEY REFERENCES households(id),
    token_hash text UNIQUE,
    start_date text NOT NULL,
    token_created_at text,
    token_created_by integer REFERENCES users(id) ON DELETE SET NULL,
    last_used_at text,
    taken_up_to integer NOT NULL DEFAULT 0
  );
  CREATE TABLE handoff_offers (
    household_id integer NOT NULL REFERENCES households(id),
    capture_id text NOT NULL,
    number integer NOT NULL,
    status text NOT NULL CHECK (status IN ('ready', 'withdrawn')),
    message_id text NOT NULL,
    fingerprint text NOT NULL,
    document text,
    reason text,
    offered_at text NOT NULL,
    PRIMARY KEY (household_id, capture_id)
  );
  CREATE UNIQUE INDEX handoff_offers_number ON handoff_offers(household_id, number);
  ALTER TABLE billers ADD COLUMN auto_send integer NOT NULL DEFAULT 0;
  CREATE TABLE biller_clean_checks (
    biller_id integer NOT NULL REFERENCES billers(id) ON DELETE CASCADE,
    household_id integer NOT NULL REFERENCES households(id),
    capture_id text NOT NULL,
    checked_at text NOT NULL,
    PRIMARY KEY (biller_id, capture_id)
  );
  `,
  // Payment pairing (see payments/ and the vault's "Hand-off" note, section 7).
  // - payment_pairings: one row per payment email that is not left to
  //   OurHomeInbox: a person's pick of a bill ('person'), Paid on its own
  //   ('own', no bill), or the pairing as it was when the payment was first
  //   sent to OurHome ('locked', with the bill or none; never changes again).
  //   An automatic pairing that has not been sent has no row: it is worked
  //   out on read. chosen_by is who chose it (NULL for an automatic one).
  // - ourhome_changes: what OurHome reported a person did to an email bill
  //   there (paid by hand, removed), by the bill's Message-ID as offered.
  `
  CREATE TABLE payment_pairings (
    household_id integer NOT NULL REFERENCES households(id),
    payment_id text NOT NULL,
    bill_id text,
    how text NOT NULL CHECK (how IN ('person', 'own', 'locked')),
    chosen_by integer REFERENCES users(id) ON DELETE SET NULL,
    chosen_at text NOT NULL,
    PRIMARY KEY (household_id, payment_id),
    CHECK (how <> 'person' OR bill_id IS NOT NULL),
    CHECK (how <> 'own' OR bill_id IS NULL)
  );
  CREATE INDEX payment_pairings_bill ON payment_pairings(household_id, bill_id);
  CREATE TABLE ourhome_changes (
    household_id integer NOT NULL REFERENCES households(id),
    message_id text NOT NULL,
    change text NOT NULL CHECK (change IN ('paid', 'removed')),
    at text NOT NULL,
    received_at text NOT NULL,
    PRIMARY KEY (household_id, message_id, change)
  );
  `,
  // A mailbox reads one or more folders (owner, 2026-11-04). Each folder's
  // captured mail sits under data/mail/<its slug>, so two folders' message
  // numbers never meet. A mailbox's first folder uses the mailbox's own slug,
  // which is where its mail already is. A folder taken off the list is kept,
  // marked removed: its emails stay shown, and listing it again picks up
  // where it left off instead of capturing everything a second time.
  `
  CREATE TABLE mailbox_folders (
    id integer PRIMARY KEY,
    mailbox_id integer NOT NULL REFERENCES mailboxes(id),
    folder text NOT NULL,
    slug text NOT NULL UNIQUE,
    position integer NOT NULL,
    removed_at text,
    created_at text NOT NULL,
    UNIQUE (mailbox_id, folder)
  );
  INSERT INTO mailbox_folders (mailbox_id, folder, slug, position, created_at)
    SELECT id, folder, slug, 0, created_at FROM mailboxes WHERE folder <> '';
  ALTER TABLE mailboxes DROP COLUMN folder;
  `,
  // Folders or labels to leave out (owner, 2026-11-05): an email also in one
  // of them is not captured, so a mail filter's label keeps unwanted emails
  // (the city's second email about each bill) out of the inbox.
  `
  CREATE TABLE mailbox_skip_folders (
    mailbox_id integer NOT NULL REFERENCES mailboxes(id),
    folder text NOT NULL,
    position integer NOT NULL,
    PRIMARY KEY (mailbox_id, folder)
  );
  `,
  // One payment for several bills (owner, 2026-11-05; contract v3): a
  // person's pick or a locked pairing keeps its other bills, oldest first, as
  // a JSON array of capture ids; bill_id stays the oldest. '[]' for one bill.
  `
  ALTER TABLE payment_pairings ADD COLUMN also_bill_ids text NOT NULL DEFAULT '[]';
  `,
];

/** The schema version this code expects. */
export const SCHEMA_VERSION = MIGRATIONS.length;

/** A small typed wrapper around node:sqlite. Statements are prepared once and reused. */
export class Database {
  private readonly statements = new Map<string, StatementSync>();

  constructor(private readonly db: DatabaseSync) {}

  /** Runs a statement that changes rows. */
  run(sql: string, ...params: SqlValue[]): { changes: number; lastInsertRowid: number } {
    const result = this.prepare(sql).run(...params);
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
  }

  /** The first row, or undefined. The caller states the row's shape, matching its SELECT. */
  get<T>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.prepare(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, ...params: SqlValue[]): T[] {
    return this.prepare(sql).all(...params) as T[];
  }

  /**
   * Runs `fn` as one transaction: all of it happens or none of it does.
   * IMMEDIATE takes the write lock at the start, so a check and the insert it
   * guards cannot be split by another writer.
   */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw err;
    }
  }

  get schemaVersion(): number {
    return this.get<{ user_version: number }>("PRAGMA user_version")?.user_version ?? 0;
  }

  close(): void {
    this.statements.clear();
    if (this.db.isOpen) this.db.close();
  }

  /** For migrations only: runs several statements at once, with no parameters. */
  exec(sql: string): void {
    this.db.exec(sql);
  }

  private prepare(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }
}

/** Opens (creating if needed) the database file and brings its schema up to date. */
export function openDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(new DatabaseSync(path, { enableForeignKeyConstraints: true, timeout: 5000 }));
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

function migrate(db: Database): void {
  const current = db.schemaVersion;
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `The database was made by a newer version of OurHomeInbox (schema ${current}, this version knows up to ${SCHEMA_VERSION}). Update OurHomeInbox.`,
    );
  }
  for (let version = current + 1; version <= SCHEMA_VERSION; version++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version - 1]!);
      db.exec(`PRAGMA user_version = ${version}`);
    });
  }
}
