import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword, LoginLimiter, verifyPassword } from "../../src/server/auth.js";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, openDatabase, SCHEMA_VERSION } from "../../src/server/db.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ourhomeinbox-db-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("openDatabase", () => {
  it("creates the file and its folder, and brings the schema up to date", () => {
    const db = openDatabase(join(dir, "nested", "app.db"));
    expect(db.schemaVersion).toBe(SCHEMA_VERSION);
    const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((t) => t.name);
    expect(tables).toEqual([
      "app_state",
      "biller_clean_checks",
      "biller_rules",
      "biller_senders",
      "billers",
      "capture_as_bill",
      "capture_reviews",
      "capture_tags",
      "handoff_connections",
      "handoff_offers",
      "households",
      "mailbox_folders",
      "mailbox_skip_folders",
      "mailboxes",
      "ourhome_changes",
      "payment_pairings",
      "sessions",
      "tags",
      "users",
    ]);
    expect(db.get<{ journal_mode: string }>("PRAGMA journal_mode")?.journal_mode).toBe("wal");
    expect(db.get<{ foreign_keys: number }>("PRAGMA foreign_keys")?.foreign_keys).toBe(1);
    db.close();
  });

  it("opens an existing database without running migrations again", () => {
    const path = join(dir, "app.db");
    const first = openDatabase(path);
    first.run("INSERT INTO households (name, created_at) VALUES (?, ?)", "Home", "2026-10-29T00:00:00.000Z");
    first.close();
    const second = openDatabase(path);
    expect(second.get<{ n: number }>("SELECT count(*) AS n FROM households")?.n).toBe(1);
    second.close();
  });

  it("moves each mailbox's folder into its folder list, keeping where its mail is (schema 12)", () => {
    const path = join(dir, "app.db");
    const old = new DatabaseSync(path);
    for (const [i, sql] of MIGRATIONS.slice(0, 11).entries()) {
      old.exec(sql);
      old.exec(`PRAGMA user_version = ${i + 1}`);
    }
    const stamp = "2026-10-29T00:00:00.000Z";
    old.exec(`INSERT INTO households (id, name, created_at) VALUES (1, 'Home', '${stamp}')`);
    old.exec(
      `INSERT INTO mailboxes (household_id, name, slug, provider, host, port, security, username, folder, created_at, updated_at)
       VALUES (1, 'Proton bills', 'proton-bills', 'proton-bridge', 'h', 1, 'none', 'u', 'Folders/Bills', '${stamp}', '${stamp}'),
              (1, 'Found', 'found', 'proton-bridge', '', 0, 'none', '', '', '${stamp}', '${stamp}')`,
    );
    old.close();

    const db = openDatabase(path);
    expect(db.schemaVersion).toBe(SCHEMA_VERSION);
    expect(db.all("SELECT m.name, f.folder, f.slug, f.position, f.removed_at FROM mailbox_folders f JOIN mailboxes m ON m.id = f.mailbox_id")).toEqual([
      { name: "Proton bills", folder: "Folders/Bills", slug: "proton-bills", position: 0, removed_at: null },
    ]);
    expect(db.all<{ name: string }>("PRAGMA table_info(mailboxes)").map((c) => c.name)).not.toContain("folder");
    db.close();
  });

  it("keeps every biller rule as one used always when a field can have several (schema 17)", () => {
    const path = join(dir, "app.db");
    const old = new DatabaseSync(path);
    for (const [i, sql] of MIGRATIONS.slice(0, 16).entries()) {
      old.exec(sql);
      old.exec(`PRAGMA user_version = ${i + 1}`);
    }
    const stamp = "2026-10-29T00:00:00.000Z";
    old.exec(`INSERT INTO households (id, name, created_at) VALUES (1, 'Home', '${stamp}')`);
    old.exec(`INSERT INTO billers (id, household_id, name, kind, created_at, updated_at) VALUES (1, 1, 'Xcel Energy', 'bill', '${stamp}', '${stamp}')`);
    old.exec(
      `INSERT INTO biller_rules (biller_id, household_id, field, label, created_at)
       VALUES (1, 1, 'amount', 'know that a payment of', '${stamp}'), (1, 1, 'paidDate', 'X on', '${stamp}')`,
    );
    old.close();

    const db = openDatabase(path);
    expect(db.all("SELECT field, label, use_when FROM biller_rules ORDER BY id")).toEqual([
      { field: "amount", label: "know that a payment of", use_when: "always" },
      { field: "paidDate", label: "X on", use_when: "always" },
    ]);
    // A second rule for the field, used only where nothing else gives it; never a second one used always, or the same words twice.
    db.run("INSERT INTO biller_rules (biller_id, household_id, field, label, use_when, created_at) VALUES (1, 1, 'amount', 'Past Due Balance', 'missing', ?)", stamp);
    expect(() => db.run("INSERT INTO biller_rules (biller_id, household_id, field, label, created_at) VALUES (1, 1, 'amount', 'Total', ?)", stamp)).toThrow();
    expect(() =>
      db.run("INSERT INTO biller_rules (biller_id, household_id, field, label, use_when, created_at) VALUES (1, 1, 'amount', 'past due balance', 'missing', ?)", stamp),
    ).toThrow();
    db.close();
  });

  it("refuses a database from a newer version", () => {
    const path = join(dir, "app.db");
    const db = openDatabase(path);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    db.close();
    expect(() => openDatabase(path)).toThrow(/newer version/);
  });

  it("enforces foreign keys and case-insensitive unique emails", () => {
    const db = openDatabase(join(dir, "app.db"));
    const stamp = "2026-10-29T00:00:00.000Z";
    expect(() =>
      db.run("INSERT INTO users (household_id, email, name, password_hash, created_at) VALUES (99, 'a@b.c', 'A', 'x', ?)", stamp),
    ).toThrow(/FOREIGN KEY/);
    const household = db.run("INSERT INTO households (name, created_at) VALUES ('Home', ?)", stamp).lastInsertRowid;
    db.run("INSERT INTO users (household_id, email, name, password_hash, created_at) VALUES (?, 'a@b.c', 'A', 'x', ?)", household, stamp);
    expect(() =>
      db.run("INSERT INTO users (household_id, email, name, password_hash, created_at) VALUES (?, 'A@B.C', 'A', 'x', ?)", household, stamp),
    ).toThrow(/UNIQUE/);
    db.close();
  });

  it("rolls a failed transaction back completely", () => {
    const db = openDatabase(join(dir, "app.db"));
    expect(() =>
      db.transaction(() => {
        db.run("INSERT INTO households (name, created_at) VALUES ('Home', 'now')");
        throw new Error("stop");
      }),
    ).toThrow("stop");
    expect(db.get<{ n: number }>("SELECT count(*) AS n FROM households")?.n).toBe(0);
    db.close();
  });
});

describe("passwords", () => {
  it("verifies the right password and nothing else", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
    expect(await verifyPassword("correct horse batterY", hash)).toBe(false);
    expect(await hashPassword("correct horse battery")).not.toBe(hash); // salted
  });

  it("rejects stored values it did not make", async () => {
    for (const stored of ["", "plain", "scrypt$1$8$1$$", "scrypt$99999999$8$1$c2FsdA==$aGFzaA==", "bcrypt$1$2$3$4$5"]) {
      expect(await verifyPassword("x", stored), stored).toBe(false);
    }
  });
});

describe("LoginLimiter", () => {
  it("blocks after 5 failures in 15 minutes and forgets them after", () => {
    const clock = { now: new Date("2026-10-29T12:00:00Z") };
    const limiter = new LoginLimiter(() => clock.now);
    for (let i = 0; i < 4; i++) limiter.fail("a@b.c", `ip${i}`);
    expect(limiter.blocked("a@b.c", "other")).toBe(false);
    limiter.fail("a@b.c", "ip4");
    expect(limiter.blocked("a@b.c", "other")).toBe(true);
    expect(limiter.blocked("someone@else", "ip0")).toBe(false);
    clock.now = new Date(clock.now.getTime() + 15 * 60 * 1000);
    expect(limiter.blocked("a@b.c", "other")).toBe(false);
  });

  it("clears an email's failures on a successful sign-in", () => {
    const limiter = new LoginLimiter(() => new Date());
    for (let i = 0; i < 4; i++) limiter.fail("a@b.c", `ip${i}`);
    limiter.succeed("a@b.c");
    limiter.fail("a@b.c", "ip9");
    expect(limiter.blocked("a@b.c", "x")).toBe(false);
  });
});
