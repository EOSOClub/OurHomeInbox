// A reminder used as the bill (owner, 2026-11-07). Reminders are never sent
// to OurHome, so one bill is not counted twice (vault "Extraction" note). But
// sometimes the reminder is all there is: the bill's own email never came in,
// or the biller sends its bills as reminders. A person can then mark that
// reminder as the bill, or take the mark off again:
//   PUT /api/captures/:mailbox/:uidValidity/:uid/as-bill   { asBill: true | false }
//
// The mark is applied when an email is read (captures.ts), never stored on
// the email: while the reader takes the email for a reminder and the mark
// stands, its kind is "bill" everywhere (the list, pairing, the hand-off),
// with the same checks as any other bill. Scoped to the household, like
// review marks; any member can mark. Only a reminder can be marked.
//
// Its reminders are its bills (owner, 2026-11-08): a biller that sends every
// bill as a reminder has a setting on its page (Biller.remindersAreBills).
// While it is on, each reminder from that biller is used as the bill, as if
// marked; the setting comes before any mark. A reminder used as the bill
// that has the same amount and due date as another of the biller's bills is
// still counted once (copies.ts), however many days apart they came.

import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AsBillMark, AsBillResponse, SessionUser } from "../shared/api.js";
import type { Extraction, ExtractionSummary } from "../shared/extraction.js";
import type { CaptureStore } from "../store.js";
import type { CaptureCache } from "./captureCache.js";
import { readHouseholdItems } from "./captures.js";
import type { Database } from "./db.js";
import { apiError, householdOf, jsonBody, MESSAGES, type AppEnv } from "./http.js";
import { UID, UID_VALIDITY } from "./mail.js";
import type { Mailboxes } from "./mailboxes.js";

export interface AsBillDeps {
  db: Database;
  store: CaptureStore;
  mailboxes: Mailboxes;
  cache: CaptureCache;
  now: () => Date;
}

const NOT_FOUND = "That email was not found. It may be in a mailbox that is no longer set up.";
const BAD_LINK = "That link does not point to a saved email.";
export const NOT_A_REMINDER = "Only a reminder can be used as the bill. This email is already read as something else.";

const asBillSchema = z.object({ asBill: z.boolean({ error: MESSAGES.badShape }) }, { error: MESSAGES.badShape });

interface MarkRow {
  capture_id: string;
  marked_at: string;
  name: string | null;
}

const SELECT_MARKS = `SELECT m.capture_id, m.marked_at, u.name FROM capture_as_bill m
  LEFT JOIN users u ON u.id = m.marked_by WHERE m.household_id = ?`;

/** The household's reminders marked as the bill, by capture id. */
export function asBillMarks(db: Database, householdId: number): Map<string, AsBillMark> {
  return new Map(db.all<MarkRow>(SELECT_MARKS, householdId).map((row) => [row.capture_id, { by: row.name, at: row.marked_at }]));
}

/** Why a reminder would be used as the bill: its biller's setting (named), or a person's mark on it. */
export type AsBillCause = { biller: string } | { mark: AsBillMark };

/** The cause for one email: its biller's setting first, then a mark; null when there is neither. */
export function asBillCause(biller: { name: string; remindersAreBills: boolean } | null, mark: AsBillMark | null): AsBillCause | null {
  if (biller?.remindersAreBills) return { biller: biller.name };
  return mark ? { mark } : null;
}

/** The summary as the household sees it: a reminder used as the bill is a bill. Anything else is left as the reader found it. */
export function summaryAsBill(picked: ExtractionSummary, cause: AsBillCause | null): ExtractionSummary {
  return cause && picked.kind === "reminder" ? { ...picked, kind: "bill" } : picked;
}

/** Why a reminder used as the bill is a bill, in plain words, keeping why the reader took it for a reminder. */
export function asBillReason(cause: AsBillCause, readerReason: string): string {
  const why =
    "biller" in cause
      ? `${cause.biller} sends its bills as reminders (set on the biller's page), so this reminder is used as the bill.`
      : `Marked as the bill by ${cause.mark.by ?? "someone no longer in the household"}.`;
  return `${why} On its own, OurHomeInbox took it for a reminder. ${readerReason}`;
}

/** The full extraction as the household sees it, with the mark or the biller's setting when it is in effect (only on a reminder). */
export function extractionAsBill(
  extraction: Extraction,
  cause: AsBillCause | null,
): { extraction: Extraction; asBill: AsBillMark | null; asBillByBiller: boolean } {
  if (!cause || extraction.kind !== "reminder") return { extraction, asBill: null, asBillByBiller: false };
  return {
    extraction: { ...extraction, kind: "bill", kindReason: asBillReason(cause, extraction.kindReason) },
    asBill: "mark" in cause ? cause.mark : null,
    asBillByBiller: "biller" in cause,
  };
}

/** Why an email of a biller whose reminders are its bills is not marked: its reminders already are bills, and its bills need no mark. */
export function byBillerAlready(biller: string): string {
  return `${biller} sends its bills as reminders (set on the biller's page), so its reminders are already used as its bills.`;
}

export function asBillRoutes(deps: AsBillDeps): Hono<AppEnv> {
  const { db, mailboxes, now } = deps;
  const app = new Hono<AppEnv>();

  /** The email the route names, as its capture id, or an error reply. Only the household's own mailboxes count. */
  const emailId = (c: Context<AppEnv>): string | Response => {
    const { mailbox: slug = "", uidValidity = "", uid = "" } = c.req.param();
    if (!mailboxes.places(householdOf(c)).has(slug)) return apiError(c, 404, NOT_FOUND);
    if (!UID_VALIDITY.test(uidValidity) || !UID.test(uid) || !Number.isSafeInteger(Number(uid))) return apiError(c, 400, BAD_LINK);
    return `${slug}/${uidValidity}/${Number(uid)}`;
  };

  app.put("/captures/:mailbox/:uidValidity/:uid/as-bill", jsonBody(asBillSchema), async (c) => {
    const id = emailId(c);
    if (id instanceof Response) return id;
    const householdId = householdOf(c);
    const { asBill } = c.req.valid("json");
    const item = (await readHouseholdItems(deps, householdId, [id])).get(id);
    if (!item) return apiError(c, 404, NOT_FOUND);

    if (!asBill) {
      db.run("DELETE FROM capture_as_bill WHERE household_id = ? AND capture_id = ?", householdId, id);
    } else {
      const marked = asBillMarks(db, householdId).has(id);
      // Marked already: the item reads as a bill, and who marked it first, and when, stay.
      if (!marked) {
        const byBiller =
          item.biller && db.get("SELECT 1 FROM billers WHERE id = ? AND household_id = ? AND reminders_are_bills = 1", item.biller.id, householdId);
        if (item.biller && byBiller) return apiError(c, 409, byBillerAlready(item.biller.name));
        if (item.picked.kind !== "reminder") return apiError(c, 409, NOT_A_REMINDER);
        db.run(
          "INSERT INTO capture_as_bill (household_id, capture_id, marked_by, marked_at) VALUES (?, ?, ?, ?)",
          householdId,
          id,
          (c.var.user as SessionUser).id,
          now().toISOString(),
        );
      }
    }
    const body: AsBillResponse = { asBill: asBillMarks(db, householdId).get(id) ?? null };
    return c.json(body);
  });

  return app;
}
