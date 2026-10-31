// The server's own database: households, accounts, sign-in sessions and each
// household's billers and their rules, in one SQLite file next to the captured mail. Captured
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
// one household made at first-time setup.
const MIGRATIONS: string[] = [
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
