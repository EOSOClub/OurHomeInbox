// Export as CSV: one row per email, the columns in exportColumns.ts.
//
// Most of a row came from strangers' email. A spreadsheet runs a cell that
// starts with = + - or @ as a formula, so every cell of words gets a leading
// apostrophe when it starts with one of those (the usual guard, shown by
// spreadsheets as plain text). Money and days are written by OurHomeInbox
// itself ("114.93", "-85.27", "2026-11-04") and are left as they are, so they
// stay numbers and dates in the spreadsheet.

import type { CaptureListItem } from "../../../src/shared/api";
import { COLUMNS } from "./exportColumns";

const FORMULA_START = /^[=+\-@\t\r\n]/;

/** A cell a spreadsheet will show as written: guarded against formulas when it is words, then quoted when it must be. */
export function csvCell(value: string, text: boolean): string {
  const safe = text && FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]|^\s|\s$/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** The CSV for these emails, in this order: a heading row, then one row per email, lines ended with CRLF (RFC 4180). */
export function capturesCsv(items: readonly CaptureListItem[]): string {
  const rows = [COLUMNS.map((column) => csvCell(column.heading, true))];
  for (const item of items) {
    rows.push(
      COLUMNS.map((column) => {
        const cell = column.cell(item);
        return csvCell(cell.value, cell.kind === "text");
      }),
    );
  }
  return rows.map((row) => row.join(",")).join("\r\n") + "\r\n";
}
