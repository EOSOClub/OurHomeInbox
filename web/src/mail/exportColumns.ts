// What an exported email row holds, shared by the CSV and Excel files: the
// columns in order, each with its heading, a width for Excel, and its cell for
// an email. A cell says what kind of value it is, so each file can write it
// properly: money and days that OurHomeInbox wrote itself become numbers and
// dates; everything else is words, much of it from strangers' email.

import type { CaptureListItem } from "../../../src/shared/api";
import { FIELD_TYPES, FIELDS, type FieldName } from "../../../src/shared/extraction";
import { senderDisplay, subjectDisplay } from "../format";
import { captureDate, localDay } from "./captureList";
import { FIELD_LABELS, KIND_LABELS } from "./picked";
import { REVIEW_LABELS } from "./review";

/**
 * - text: words, possibly from an email; an empty cell is text "".
 * - money: OurHomeInbox's own amount, such as "114.93" or "-85.27" (a credit).
 * - day: OurHomeInbox's own day, such as "2026-11-04".
 */
export type ExportCell = { kind: "text"; value: string } | { kind: "money"; value: string } | { kind: "day"; value: string };

export interface ExportColumn {
  heading: string;
  /** In Excel's units (about one character each), wide enough for the heading. */
  width: number;
  cell: (item: CaptureListItem) => ExportCell;
}

const text = (value: string): ExportCell => ({ kind: "text", value });
const day = (value: string): ExportCell => (value ? { kind: "day", value } : text(""));

/** True when the email gives more than one value for the field, so a person must check. */
export const inDoubt = (item: CaptureListItem, field: FieldName) => (item.picked.values[field]?.length ?? 0) > 1;

/**
 * A field's cell. One value of money or a day is OurHomeInbox's own; numbers
 * (account, invoice) are as written in the email, so they are words, and keep
 * any leading zeros. Values in doubt are joined words: "10.00 or 12.00".
 */
function fieldCell(item: CaptureListItem, field: FieldName): ExportCell {
  const values = item.picked.values[field] ?? [];
  if (values.length !== 1) return text(values.join(" or "));
  const value = values[0]!;
  const type = FIELD_TYPES[field];
  return type === "money" ? { kind: "money", value } : type === "date" ? day(value) : text(value);
}

const FIELD_WIDTHS: Record<FieldName, number> = {
  amount: 10,
  fee: 8,
  dueDate: 11,
  paidDate: 11,
  accountNo: 17,
  invoiceNo: 16,
  confirmationNo: 21,
};

/** The columns, in order. Days are in the browser's time zone, as the list shows them. */
export const COLUMNS: readonly ExportColumn[] = [
  { heading: "Date", width: 11, cell: (item) => day(localDay(captureDate(item))) },
  { heading: "From", width: 24, cell: (item) => text(senderDisplay(item.from)) },
  { heading: "From address", width: 30, cell: (item) => text(item.from.map((a) => a.address.trim()).filter(Boolean).join("; ")) },
  { heading: "Subject", width: 48, cell: (item) => text(subjectDisplay(item.subject)) },
  { heading: "Biller", width: 20, cell: (item) => text(item.biller?.name ?? "") },
  { heading: "Kind", width: 10, cell: (item) => text(KIND_LABELS[item.picked.kind]) },
  ...FIELDS.map((field): ExportColumn => ({ heading: FIELD_LABELS[field], width: FIELD_WIDTHS[field], cell: (item) => fieldCell(item, field) })),
  { heading: "Past due", width: 9, cell: (item) => text(item.picked.dueNow ? "Yes" : "") },
  {
    heading: "Values in doubt",
    width: 16,
    cell: (item) =>
      text(
        FIELDS.filter((field) => inDoubt(item, field))
          .map((field) => FIELD_LABELS[field])
          .join(", "),
      ),
  },
  { heading: "Review", width: 11, cell: (item) => text(item.review ? REVIEW_LABELS[item.review.state] : "To review") },
  { heading: "Reviewed by", width: 16, cell: (item) => text(item.review?.by ?? "") },
  { heading: "Reviewed on", width: 12, cell: (item) => day(item.review ? localDay(item.review.at) : "") },
  { heading: "Tags", width: 24, cell: (item) => text(item.tags.map((tag) => tag.name).join("; ")) },
  { heading: "Sender verified", width: 15, cell: (item) => text(item.senderVerified ? "Yes" : "No") },
  { heading: "Mailbox", width: 20, cell: (item) => text(item.mailbox) },
  { heading: "Email id", width: 34, cell: (item) => text(item.id) },
];
