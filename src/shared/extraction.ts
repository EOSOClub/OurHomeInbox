// What the reader picked out of one email, as the API sends it. Types and
// names only, so the web app can use them too; the reading itself is in
// src/server/extraction.ts.

/** The values the reader looks for, in the order they are shown. */
export const FIELDS = ["amount", "fee", "dueDate", "paidDate", "accountNo", "invoiceNo", "confirmationNo"] as const;
export type FieldName = (typeof FIELDS)[number];

/** What kind of value each field holds. */
export const FIELD_TYPES: Record<FieldName, "money" | "date" | "number"> = {
  amount: "money",
  fee: "money",
  dueDate: "date",
  paidDate: "date",
  accountNo: "number",
  invoiceNo: "number",
  confirmationNo: "number",
};

/**
 * - bill: asks for money (an amount or a due date was found).
 * - reminder: a reminder of a bill already sent ("Second Notice", "Bill Due").
 * - receipt: confirms a payment.
 * - statement: none of those, such as "your statement is ready" with no amount.
 */
export const EMAIL_KINDS = ["bill", "reminder", "receipt", "statement"] as const;
export type EmailKind = (typeof EMAIL_KINDS)[number];

/** A range of characters in one piece, `end` exclusive. */
export interface PieceRange {
  start: number;
  end: number;
}

/** One place a label and its value were found. The value may be in the label's piece or the next one. */
export interface PickSpot {
  labelPiece: number;
  label: PieceRange;
  valuePiece: number;
  value: PieceRange;
}

export interface PickedValue {
  /** Money as "114.93" or "-85.27" (a credit), dates as "2026-11-04", numbers as written. */
  value: string;
  /** The value as written in the email. */
  shown: string;
  /** The label it was found by, as written in the email. */
  label: string;
  /** Every place this label and value appear. Emails that repeat a block (one copy for phones, one for computers) give more than one. */
  spots: PickSpot[];
}

export interface PickedField {
  field: FieldName;
  /** One value, or more than one when the email disagrees with itself (a person must check). */
  values: PickedValue[];
  /** Who found it. Biller rules come later. */
  by: "reader";
}

export interface Extraction {
  /** The body that was read, or null when the email has no body. */
  source: "html" | "text" | null;
  /** The body as the reader saw it. Spots point into these. */
  pieces: string[];
  kind: EmailKind;
  /** Why the email was given its kind, in plain words. */
  kindReason: string;
  /** Only the fields that were found, in FIELDS order. */
  fields: PickedField[];
}

/** The few values shown in the list of emails. Null when not found or in doubt. */
export interface ExtractionSummary {
  kind: EmailKind;
  amount: string | null;
  dueDate: string | null;
  paidDate: string | null;
  /** True when some value has more than one candidate and needs a person. */
  needsCheck: boolean;
}
