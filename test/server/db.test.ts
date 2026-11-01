import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword, LoginLimiter, verifyPassword } from "../../src/server/auth.js";
import { openDatabase, SCHEMA_VERSION } from "../../src/server/db.js";

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
      "biller_rules",
      "biller_senders",
      "billers",
      "capture_reviews",
      "capture_tags",
      "households",
      "mailboxes",
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
