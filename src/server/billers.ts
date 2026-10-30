// The household's billers: who its bills come from, and the addresses their
// emails are sent from.
//   GET    /api/billers       every biller, by name
//   POST   /api/billers       add one
//   GET    /api/billers/:id   one biller
//   PUT    /api/billers/:id   change one (the whole biller is sent)
//   DELETE /api/billers/:id   remove one
//
// Everything is scoped to the signed-in person's household. Another
// household's biller is "not found", never "forbidden", so its existence does
// not leak.

import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Biller, BillerListResponse, SessionUser } from "../shared/api.js";
import {
  BILLER_KINDS,
  MAX_BILLER_NAME,
  MAX_BILLER_NOTES,
  MAX_BILLER_SENDERS,
  senderProblem,
  uniqueSenders,
  type BillerKind,
} from "../shared/billers.js";
import type { Database } from "./db.js";
import { apiError, jsonBody, MESSAGES, type AppEnv } from "./http.js";

export interface BillerDeps {
  db: Database;
  now: () => Date;
}

const NOT_FOUND = "That biller was not found. It may have been deleted.";
const ID = /^[1-9]\d*$/;

const billerSchema = z.object(
  {
    name: z
      .string({ error: "Enter the biller's name." })
      .trim()
      .min(1, "Enter the biller's name.")
      .max(MAX_BILLER_NAME, `Keep the name under ${MAX_BILLER_NAME} characters.`),
    kind: z.enum(BILLER_KINDS, { error: "Choose whether this is a bill or a subscription." }),
    senders: z
      // Generous per-item limit: senderProblem gives the real message for a long one.
      .array(z.string({ error: MESSAGES.badShape }).max(1000, "One of the email addresses is far too long."), {
        error: "List the email addresses as a list.",
      })
      .transform(uniqueSenders)
      .superRefine((senders, ctx) => {
        if (senders.length > MAX_BILLER_SENDERS) {
          ctx.addIssue({ code: "custom", message: `List at most ${MAX_BILLER_SENDERS} email addresses for one biller.` });
          return;
        }
        for (const sender of senders) {
          const problem = senderProblem(sender);
          if (problem) ctx.addIssue({ code: "custom", message: problem });
        }
      }),
    notes: z
      .string({ error: MESSAGES.badShape })
      .trim()
      .max(MAX_BILLER_NOTES, `Keep the notes under ${MAX_BILLER_NOTES} characters.`)
      .default(""),
  },
  { error: MESSAGES.badShape },
);

type BillerFields = z.output<typeof billerSchema>;

interface BillerRow {
  id: number;
  name: string;
  kind: BillerKind;
  notes: string;
  created_at: string;
  updated_at: string;
}

function toBiller(row: BillerRow, senders: string[]): Biller {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    senders,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const BILLER_COLUMNS = "id, name, kind, notes, created_at, updated_at";

export function listBillers(db: Database, householdId: number): Biller[] {
  const rows = db.all<BillerRow>(
    `SELECT ${BILLER_COLUMNS} FROM billers WHERE household_id = ? ORDER BY name COLLATE NOCASE, id`,
    householdId,
  );
  const senders = new Map<number, string[]>();
  for (const s of db.all<{ biller_id: number; sender: string }>(
    "SELECT biller_id, sender FROM biller_senders WHERE household_id = ? ORDER BY biller_id, position",
    householdId,
  )) {
    const list = senders.get(s.biller_id);
    if (list) list.push(s.sender);
    else senders.set(s.biller_id, [s.sender]);
  }
  return rows.map((row) => toBiller(row, senders.get(row.id) ?? []));
}

export function getBiller(db: Database, householdId: number, id: number): Biller | null {
  const row = db.get<BillerRow>(`SELECT ${BILLER_COLUMNS} FROM billers WHERE id = ? AND household_id = ?`, id, householdId);
  if (!row) return null;
  const senders = db
    .all<{ sender: string }>("SELECT sender FROM biller_senders WHERE biller_id = ? ORDER BY position", id)
    .map((s) => s.sender);
  return toBiller(row, senders);
}

/** Why `fields` cannot be saved alongside the household's other billers, or null. `id` is the biller being changed. */
function conflict(db: Database, householdId: number, fields: BillerFields, id: number | null): string | null {
  const sameName = db.get<{ name: string }>(
    "SELECT name FROM billers WHERE household_id = ? AND name = ? COLLATE NOCASE AND id IS NOT ?",
    householdId,
    fields.name,
    id,
  );
  if (sameName) return `There is already a biller called ${sameName.name}.`;
  for (const sender of fields.senders) {
    const owner = db.get<{ name: string }>(
      `SELECT b.name FROM biller_senders s JOIN billers b ON b.id = s.biller_id
       WHERE s.household_id = ? AND s.sender = ? AND s.biller_id IS NOT ?`,
      householdId,
      sender,
      id,
    );
    if (owner) return `${sender} is already listed for ${owner.name}. An address can belong to one biller only.`;
  }
  return null;
}

function writeSenders(db: Database, householdId: number, billerId: number, senders: string[]): void {
  db.run("DELETE FROM biller_senders WHERE biller_id = ?", billerId);
  senders.forEach((sender, position) => {
    db.run(
      "INSERT INTO biller_senders (biller_id, household_id, sender, position) VALUES (?, ?, ?, ?)",
      billerId,
      householdId,
      sender,
      position,
    );
  });
}

/** The :id param as a number, or null when it cannot name a biller. */
function billerId(c: Context): number | null {
  const text = c.req.param("id") ?? "";
  if (!ID.test(text)) return null;
  const id = Number(text);
  return Number.isSafeInteger(id) ? id : null;
}

/** Signed in is guaranteed by requireSignIn; this narrows the type. */
function householdOf(c: Context<AppEnv>): number {
  return (c.var.user as SessionUser).household.id;
}

export function billerRoutes(deps: BillerDeps): Hono<AppEnv> {
  const { db, now } = deps;
  const app = new Hono<AppEnv>();

  app.get("/billers", (c) => {
    const body: BillerListResponse = { billers: listBillers(db, householdOf(c)) };
    return c.json(body);
  });

  app.post("/billers", jsonBody(billerSchema), (c) => {
    const householdId = householdOf(c);
    const fields = c.req.valid("json");
    const stamp = now().toISOString();
    // The check and the writes are one transaction, so two saves racing cannot both pass it.
    const result = db.transaction((): { problem: string } | { id: number } => {
      const problem = conflict(db, householdId, fields, null);
      if (problem) return { problem };
      const id = db.run(
        "INSERT INTO billers (household_id, name, kind, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        householdId,
        fields.name,
        fields.kind,
        fields.notes,
        stamp,
        stamp,
      ).lastInsertRowid;
      writeSenders(db, householdId, id, fields.senders);
      return { id };
    });
    if ("problem" in result) return apiError(c, 409, result.problem);
    return c.json(getBiller(db, householdId, result.id)!, 201);
  });

  app.get("/billers/:id", (c) => {
    const id = billerId(c);
    const biller = id === null ? null : getBiller(db, householdOf(c), id);
    if (!biller) return apiError(c, 404, NOT_FOUND);
    return c.json(biller);
  });

  app.put("/billers/:id", jsonBody(billerSchema), (c) => {
    const id = billerId(c);
    if (id === null) return apiError(c, 404, NOT_FOUND);
    const householdId = householdOf(c);
    const fields = c.req.valid("json");
    const stamp = now().toISOString();
    const result = db.transaction((): { missing: true } | { problem: string } | { saved: true } => {
      if (!db.get("SELECT 1 FROM billers WHERE id = ? AND household_id = ?", id, householdId)) return { missing: true };
      const problem = conflict(db, householdId, fields, id);
      if (problem) return { problem };
      db.run(
        "UPDATE billers SET name = ?, kind = ?, notes = ?, updated_at = ? WHERE id = ?",
        fields.name,
        fields.kind,
        fields.notes,
        stamp,
        id,
      );
      writeSenders(db, householdId, id, fields.senders);
      return { saved: true };
    });
    if ("missing" in result) return apiError(c, 404, NOT_FOUND);
    if ("problem" in result) return apiError(c, 409, result.problem);
    return c.json(getBiller(db, householdId, id)!);
  });

  app.delete("/billers/:id", (c) => {
    const id = billerId(c);
    const removed = id === null ? 0 : db.run("DELETE FROM billers WHERE id = ? AND household_id = ?", id, householdOf(c)).changes;
    if (removed === 0) return apiError(c, 404, NOT_FOUND);
    return c.body(null, 204);
  });

  return app;
}
