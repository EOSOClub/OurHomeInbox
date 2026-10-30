// How the reader's picks are named and shown: field and kind names, money
// and days, and the marks that show where each value sits in the email.

import type { EmailKind, Extraction, ExtractionSummary, FieldName, PickedField } from "../../../src/shared/extraction";
import { FIELD_TYPES } from "../../../src/shared/extraction";
import { readText } from "../../../src/shared/reading";
import type { TextHighlight } from "./highlight";

export const KIND_LABELS: Record<EmailKind, string> = {
  bill: "Bill",
  reminder: "Reminder",
  receipt: "Receipt",
  statement: "Statement",
};

export const FIELD_LABELS: Record<FieldName, string> = {
  amount: "Amount",
  fee: "Fee",
  dueDate: "Due date",
  paidDate: "Paid on",
  accountNo: "Account number",
  invoiceNo: "Invoice number",
  confirmationNo: "Confirmation number",
};

/** The fields each kind of email is expected to have, so a missing one can be pointed out. */
export const EXPECTED_FIELDS: Record<EmailKind, readonly FieldName[]> = {
  bill: ["amount", "dueDate"],
  reminder: ["amount", "dueDate"],
  receipt: ["amount", "paidDate"],
  statement: [],
};

const DOLLARS = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** "114.93" as "$114.93"; a credit ("-85.27") as "$85.27 credit". */
export function formatMoney(value: string): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return value;
  return amount < 0 ? `${DOLLARS.format(-amount)} credit` : DOLLARS.format(amount);
}

/** A day ("2026-11-04") as "Nov 4, 2026", the same day wherever the browser is. */
export function formatDay(value: string, locale?: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(date);
}

export function formatPicked(field: FieldName, value: string, locale?: string): string {
  const type = FIELD_TYPES[field];
  if (type === "money") return formatMoney(value);
  if (type === "date") return formatDay(value, locale);
  return value;
}

/** True when the amount is a credit: nothing is owed. */
export function isCredit(field: PickedField | undefined): boolean {
  return field?.field === "amount" && field.values.length === 1 && Number(field.values[0]!.value) < 0;
}

/** The short line under an email in the list, such as "$4.13, due Nov 4, 2026". Empty when nothing was found. */
export function summaryLine(summary: ExtractionSummary, locale?: string): string {
  const parts: string[] = [];
  if (summary.amount !== null) parts.push(formatMoney(summary.amount));
  if (summary.dueDate !== null) parts.push(`due ${formatDay(summary.dueDate, locale)}`);
  if (summary.paidDate !== null) parts.push(`paid ${formatDay(summary.paidDate, locale)}`);
  return parts.join(", ");
}

/** One mark to place in the email: a label or a value, in a piece of the reader's text. */
export interface PieceMark {
  piece: number;
  start: number;
  end: number;
  role: "label" | "value";
  /** The field's name, shown beside a value in the email. */
  name: string;
}

/** Marks for every place each picked value was found, labels and values both. */
export function marksFor(extraction: Extraction): PieceMark[] {
  const marks: PieceMark[] = [];
  for (const field of extraction.fields) {
    const name = FIELD_LABELS[field.field];
    for (const value of field.values) {
      for (const spot of value.spots) {
        marks.push({ piece: spot.labelPiece, ...spot.label, role: "label", name });
        marks.push({ piece: spot.valuePiece, ...spot.value, role: "value", name });
      }
    }
  }
  return marks;
}

/**
 * Highlights for a plain text body the reader read, as offsets into `text`.
 * A mark whose line reads differently here than on the server is left out.
 */
export function textHighlights(text: string, extraction: Extraction): TextHighlight[] {
  if (extraction.source !== "text") return [];
  const reading = readText(text);
  return marksFor(extraction).flatMap((mark) => {
    if (reading.pieces[mark.piece] !== extraction.pieces[mark.piece]) return [];
    return reading
      .locate(mark.piece, mark.start, mark.end)
      .map((range) => ({ start: range.start, end: range.end, label: mark.name, tone: mark.role }));
  });
}

/** A piece shortened to about `room` characters around [start, end), with an ellipsis where text was cut. */
export function around(piece: string, start: number, end: number, room = 90): { text: string; offset: number } {
  if (piece.length <= room) return { text: piece, offset: 0 };
  const spare = Math.max(0, room - (end - start));
  let from = Math.max(0, start - Math.floor(spare / 2));
  const to = Math.min(piece.length, from + Math.max(room, end - start));
  from = Math.max(0, Math.min(from, to - room));
  const head = from > 0 ? "…" : "";
  const tail = to < piece.length ? "…" : "";
  return { text: head + piece.slice(from, to) + tail, offset: from - head.length };
}
