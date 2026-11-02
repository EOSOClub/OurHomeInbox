// A biller earning Send automatically (owner, 2026-11-01): each Checked email
// of a biller that needed no fix adds to its run; at CHECKS_BEFORE_AUTO in a
// row the page offers to turn Send automatically on.
//
// What breaks the run (the owner confirmed Claude's reading, 2026-11-01):
// - a Fix of one of the biller's values (a rule saved or removed);
// - a Checked email that had a value in doubt or an unverified sender.
// Marking an email Not a bill neither counts nor breaks it. An email counts
// once, however often it is marked. Turning Send automatically on or off, or
// "Not now", starts the run again.

import { CHECKS_BEFORE_AUTO } from "../../shared/handoff.js";
import type { Database } from "../db.js";

/** One email just marked Checked: its biller, and whether it needed nothing (no doubt, sender verified). */
export interface CheckedEmail {
  captureId: string;
  billerId: number;
  clean: boolean;
}

/** Ends the biller's run. */
export function breakRun(db: Database, billerId: number): void {
  db.run("DELETE FROM biller_clean_checks WHERE biller_id = ?", billerId);
}

/** Adds newly Checked emails to their billers' runs, in order. Returns the billers touched. Call inside a transaction. */
export function recordChecks(db: Database, householdId: number, emails: readonly CheckedEmail[], stamp: string): Set<number> {
  const touched = new Set<number>();
  for (const email of emails) {
    touched.add(email.billerId);
    if (email.clean) {
      db.run(
        "INSERT INTO biller_clean_checks (biller_id, household_id, capture_id, checked_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
        email.billerId,
        householdId,
        email.captureId,
        stamp,
      );
    } else {
      breakRun(db, email.billerId);
    }
  }
  return touched;
}

/** Of these billers, the household's that have earned the offer and do not send automatically yet. */
export function autoSendOffers(db: Database, householdId: number, billerIds: Iterable<number>): Array<{ id: number; name: string }> {
  const offers: Array<{ id: number; name: string }> = [];
  for (const id of billerIds) {
    const row = db.get<{ id: number; name: string; auto_send: number; run: number }>(
      `SELECT b.id, b.name, b.auto_send, (SELECT count(*) FROM biller_clean_checks c WHERE c.biller_id = b.id) AS run
         FROM billers b WHERE b.id = ? AND b.household_id = ?`,
      id,
      householdId,
    );
    if (row && row.auto_send === 0 && row.run >= CHECKS_BEFORE_AUTO) offers.push({ id: row.id, name: row.name });
  }
  return offers.sort((a, b) => a.name.localeCompare(b.name));
}

/** Turns Send automatically on or off ("Not now" is off); either way the run starts again. False when the biller is not the household's. */
export function setAutoSend(db: Database, householdId: number, billerId: number, on: boolean): boolean {
  return db.transaction(() => {
    const changed = db.run("UPDATE billers SET auto_send = ? WHERE id = ? AND household_id = ?", on ? 1 : 0, billerId, householdId).changes;
    if (changed === 0) return false;
    breakRun(db, billerId);
    return true;
  });
}

/** The household's billers that send automatically, by id. */
export function autoSendBillers(db: Database, householdId: number): Set<number> {
  return new Set(db.all<{ id: number }>("SELECT id FROM billers WHERE household_id = ? AND auto_send = 1", householdId).map((r) => r.id));
}
