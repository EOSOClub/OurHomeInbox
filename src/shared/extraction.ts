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
  /** Who found it: the built-in reader's labels, or the biller's rule for this field. */
  by: "reader" | "rule";
  /**
   * Where: the email's body (spots point into Extraction.pieces) or the
   * invoice its link gave (spots point into Extraction.invoice.pieces).
   */
  from: "email" | "invoice";
}

/** Where a piece of an invoice sits: its page (from 1) and its line on that page (from 0). */
export interface PiecePlace {
  page: number;
  line: number;
}

/** An invoice's text as the reader sees it, read once when it is saved. */
export interface InvoiceText {
  pieces: string[];
  places: PiecePlace[];
  /** For each piece, the piece just below it on the page (labels above their values), or null. */
  below: Array<number | null>;
}

/**
 * A biller's rule, saved by Fix: in that biller's emails, the field is the
 * value after this label. It is tried before the built-in labels; an email
 * without the label falls back to them.
 */
export interface BillerRule {
  field: FieldName;
  /** As written in the email it was chosen from; matched ignoring case. */
  label: string;
}

export const MAX_RULE_LABEL = 60;

/** One value Fix offers for a field: a value of the right kind, and the words before it that a rule would look for. */
export interface FieldChoice {
  /** The label a rule would save. */
  label: string;
  /** Whether it is in the email's body or its invoice. */
  from: "email" | "invoice";
  /** The value this email would get with that rule. */
  value: PickedValue;
  /** True when this is what is picked now. */
  current: boolean;
  /** How many different values the label gives in this email. More than one would still need a check. */
  valuesHere: number;
  /** How many of the biller's other emails would get a different value with this rule. */
  changes: number;
}

export interface Extraction {
  /** The body that was read, or null when the email has no body. */
  source: "html" | "text" | null;
  /** The body as the reader saw it. Spots point into these. */
  pieces: string[];
  kind: EmailKind;
  /** Why the email was given its kind, in plain words. */
  kindReason: string;
  /**
   * Only the fields that were found, in FIELDS order. The email's own value
   * wins; the invoice fills in what the email lacks, or wins when a biller's
   * rule finds it there.
   */
  fields: PickedField[];
  /** The invoice its link gave, when there is one: spots of fields from the invoice point into these pieces. */
  invoice: { pieces: string[]; places: PiecePlace[] } | null;
  /** Where the email or its invoice says the account is past due, so the bill is due now; null when it does not. */
  dueNow: DueNow | null;
}

/** The words saying an account is past due ("Your account is Past Due."), and where they are. */
export interface DueNow {
  from: "email" | "invoice";
  /** The piece (of the email's body or the invoice) and the range of the words in it. */
  piece: number;
  start: number;
  end: number;
  /** The words as written. */
  said: string;
}

/** The few values shown in the list of emails. Null when not found or in doubt. */
export interface ExtractionSummary {
  kind: EmailKind;
  amount: string | null;
  dueDate: string | null;
  paidDate: string | null;
  /** True when the email or its invoice says the account is past due: the bill is due now, whatever date it prints. */
  dueNow: boolean;
  /** True when some value has more than one candidate and needs a person. */
  needsCheck: boolean;
  /**
   * Every value found, by field (as PickedValue.value), for the export. A
   * field the reader did not find is left out; more than one value means the
   * email disagrees with itself.
   */
  values: Partial<Record<FieldName, string[]>>;
}
