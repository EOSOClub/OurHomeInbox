// Pairing's records (migration 11; migration 14 adds the other bills a payment
// for several bills also pays): the pairings people chose or that were
// locked when a payment was first sent to OurHome, and what OurHome reported a
// person did to an email bill there (POST /api/handoff/changes).

import type { OurHomeChangeKind } from "../../shared/payments.js";
import type { Database } from "../db.js";
import type { FixedPairing } from "./pairing.js";

interface PairingRow {
  payment_id: string;
  bill_id: string | null;
  also_bill_ids: string;
  how: "person" | "own" | "locked";
  chosen_by: number | null;
  chosen_at: string;
}

/** The other bills a row keeps (migration 14), as written; none when the text is not a list of ids. */
function alsoBills(text: string): string[] {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) && value.every((id) => typeof id === "string") ? value : [];
  } catch {
    return [];
  }
}

/** The household's fixed pairings (a person's choice, or locked on sending), by payment id. */
export function householdPairings(db: Database, householdId: number): Map<string, FixedPairing> {
  const rows = db.all<PairingRow>(
    "SELECT payment_id, bill_id, also_bill_ids, how, chosen_by, chosen_at FROM payment_pairings WHERE household_id = ?",
    householdId,
  );
  return new Map(
    rows.map((row) => [
      row.payment_id,
      {
        billId: row.bill_id,
        alsoBillIds: row.bill_id === null ? [] : alsoBills(row.also_bill_ids),
        locked: row.how === "locked",
        // A locked pairing a person had chosen keeps who chose it; Paid on its own is always a person's choice.
        person: row.how !== "locked" || row.chosen_by !== null || row.bill_id === null,
        chosenAt: row.chosen_at,
      },
    ]),
  );
}

export type PickResult = "saved" | "locked";

/**
 * A person's choice for a payment: a bill (with `alsoBillIds`, the other
 * bills it pays, when several, the oldest in `billId`), or null for Paid on
 * its own. Refused once the pairing is locked.
 */
export function setPick(
  db: Database,
  householdId: number,
  paymentId: string,
  billId: string | null,
  userId: number,
  now: Date,
  alsoBillIds: readonly string[] = [],
): PickResult {
  return db.transaction(() => {
    if (isLocked(db, householdId, paymentId)) return "locked";
    db.run(
      `INSERT INTO payment_pairings (household_id, payment_id, bill_id, also_bill_ids, how, chosen_by, chosen_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (household_id, payment_id) DO UPDATE SET bill_id = excluded.bill_id, also_bill_ids = excluded.also_bill_ids, how = excluded.how,
         chosen_by = excluded.chosen_by, chosen_at = excluded.chosen_at`,
      householdId,
      paymentId,
      billId,
      JSON.stringify(billId === null ? [] : alsoBillIds),
      billId === null ? "own" : "person",
      userId,
      now.toISOString(),
    );
    return "saved";
  });
}

/** Let OurHomeInbox choose: the person's choice goes. Refused once the pairing is locked. */
export function clearPick(db: Database, householdId: number, paymentId: string): PickResult {
  return db.transaction(() => {
    if (isLocked(db, householdId, paymentId)) return "locked";
    db.run("DELETE FROM payment_pairings WHERE household_id = ? AND payment_id = ?", householdId, paymentId);
    return "saved";
  });
}

export function isLocked(db: Database, householdId: number, paymentId: string): boolean {
  return db.get<{ one: number }>("SELECT 1 AS one FROM payment_pairings WHERE household_id = ? AND payment_id = ? AND how = 'locked'", householdId, paymentId) !== undefined;
}

/**
 * Locks these payments' pairings as they were sent to OurHome (the bill and
 * the other bills it also pays, or null for Paid on its own). A person's
 * choice keeps who made it, unless what was sent is not what they chose.
 * Already locked ones are left as they are: once sent, the bills never change.
 */
export function lockPairings(
  db: Database,
  householdId: number,
  sent: ReadonlyArray<{ paymentId: string; billId: string | null; alsoBillIds?: readonly string[] }>,
  now: Date,
): void {
  if (sent.length === 0) return;
  const stamp = now.toISOString();
  db.transaction(() => {
    for (const { paymentId, billId, alsoBillIds = [] } of sent) {
      db.run(
        `INSERT INTO payment_pairings (household_id, payment_id, bill_id, also_bill_ids, how, chosen_by, chosen_at) VALUES (?, ?, ?, ?, 'locked', NULL, ?)
         ON CONFLICT (household_id, payment_id) DO UPDATE SET
           chosen_by = CASE WHEN payment_pairings.bill_id IS excluded.bill_id AND payment_pairings.also_bill_ids = excluded.also_bill_ids
             THEN payment_pairings.chosen_by ELSE NULL END,
           bill_id = excluded.bill_id,
           also_bill_ids = excluded.also_bill_ids,
           how = 'locked'
         WHERE payment_pairings.how <> 'locked'`,
        householdId,
        paymentId,
        billId,
        JSON.stringify(billId === null ? [] : alsoBillIds),
        stamp,
      );
    }
  });
}

/** OurHome's reports, by Message-ID: the latest change for each. */
export function householdReports(db: Database, householdId: number): Map<string, { change: OurHomeChangeKind; at: string }> {
  const rows = db.all<{ message_id: string; change: OurHomeChangeKind; at: string }>(
    "SELECT message_id, change, at FROM ourhome_changes WHERE household_id = ? ORDER BY at, change",
    householdId,
  );
  return new Map(rows.map((row) => [row.message_id, { change: row.change, at: row.at }]));
}

export interface ReportedChange {
  messageId: string;
  change: OurHomeChangeKind;
  at: string;
}

/**
 * Keeps OurHome's reports about emails this household offered; a Message-ID
 * it never offered is dropped. The same report again changes nothing.
 * Returns how many were accepted and how many were unknown.
 */
export function recordChanges(db: Database, householdId: number, changes: readonly ReportedChange[], now: Date): { accepted: number; unknown: number } {
  const stamp = now.toISOString();
  return db.transaction(() => {
    let accepted = 0;
    let unknown = 0;
    for (const { messageId, change, at } of changes) {
      const offered = db.get<{ one: number }>("SELECT 1 AS one FROM handoff_offers WHERE household_id = ? AND message_id = ? LIMIT 1", householdId, messageId);
      if (!offered) {
        unknown++;
        continue;
      }
      db.run(
        "INSERT INTO ourhome_changes (household_id, message_id, change, at, received_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
        householdId,
        messageId,
        change,
        // One form ("...T15:20:00.000Z") whatever offset OurHome wrote, so the times sort in order.
        new Date(at).toISOString(),
        stamp,
      );
      accepted++;
    }
    return { accepted, unknown };
  });
}
