// The built-in reader: picks the amount, dates and numbers out of a bill
// email by the labels billers put beside them ("Amount Due: $114.93", or
// "Amount Billed:" in one table cell and "$4.13" in the next), and decides
// whether the email is a bill, a reminder, a receipt or a statement.
//
// The email's text is only ever matched against these patterns. Nothing in
// it is followed, run, or treated as an instruction.

import { parse, type DefaultTreeAdapterMap } from "parse5";
import type { Capture } from "../shared/capture.js";
import {
  FIELDS,
  FIELD_TYPES,
  type EmailKind,
  type Extraction,
  type ExtractionSummary,
  type FieldName,
  type PickedField,
  type PickedValue,
  type PickSpot,
} from "../shared/extraction.js";
import { readText, readTree, type Reading, type ReadingTree } from "../shared/reading.js";

type Node = DefaultTreeAdapterMap["node"];

const parse5Tree: ReadingTree<Node> = {
  text: (node) => (node.nodeName === "#text" ? (node as DefaultTreeAdapterMap["textNode"]).value : null),
  tag: (node) => ("tagName" in node ? node.tagName : null),
  // A template's content is kept apart from its children; templates are skipped anyway.
  children: (node) => ("childNodes" in node ? node.childNodes : []),
};

/** Reads an HTML body. Scripting off, as in the browser's DOMParser, so both build the same tree. */
export function readHtml(html: string): Reading {
  return readTree<Node>(parse(html, { scriptingEnabled: false }), parse5Tree);
}

// ---- Values ---------------------------------------------------------------

/** A value read at some position: its canonical form and how many characters it took. */
interface ParsedValue {
  value: string;
  length: number;
}

// $114.93, $ 60.00, $-10.72, -$10.72, ($85.27), $1,234.56, US$5. Never followed by more digits.
const MONEY = /(\()?(-)? ?(?:US)?\$ ?(-)? ?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?(?![.,]?\d)/y;
// A bare 114.93 needs its cents, so a count or a year is not read as money.
const BARE_MONEY = /(-)?(\d{1,3}(?:,\d{3})+|\d+)\.(\d{2})(?![.,]?\d)/y;

export function parseMoney(text: string, at = 0): ParsedValue | null {
  MONEY.lastIndex = at;
  const m = MONEY.exec(text);
  if (m) {
    const [whole, open, minusBefore, minusAfter, units, cents] = m;
    let length = whole.length;
    if (open) {
      // Brackets mean a credit only as a pair; a lone one is read past (and counted in the length).
      if (text[at + length] !== ")") {
        const inner = parseMoney(text, at + 1);
        return inner && { value: inner.value, length: inner.length + 1 };
      }
      length += 1;
    }
    const negative = Boolean(open) || Boolean(minusBefore) || Boolean(minusAfter);
    return { value: `${negative ? "-" : ""}${units!.replace(/,/g, "")}.${cents ?? "00"}`, length };
  }
  BARE_MONEY.lastIndex = at;
  const b = BARE_MONEY.exec(text);
  if (b) return { value: `${b[1] ?? ""}${b[2]!.replace(/,/g, "")}.${b[3]}`, length: b[0].length };
  return null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_NAME = "(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?";
const US_DATE = /(\d{1,2})([/-])(\d{1,2})\2(\d{4}|\d{2})(?![\d/-])/y;
const ISO_DATE = /(\d{4})-(\d{2})-(\d{2})(?!\d)/y;
const NAMED_DATE = new RegExp(`${MONTH_NAME} (\\d{1,2})(?:st|nd|rd|th)?,? (\\d{4})(?!\\d)`, "iy");
const DAY_FIRST_DATE = new RegExp(`(\\d{1,2}) ${MONTH_NAME},? (\\d{4})(?!\\d)`, "iy");

/** "2026-11-04", or null when there is no such day. */
function isoDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

/** Month first for numbers (11/04/2026 is November 4), as on US bills. */
export function parseDate(text: string, at = 0): ParsedValue | null {
  const attempt = (pattern: RegExp, toIso: (m: RegExpExecArray) => string | null): ParsedValue | null => {
    pattern.lastIndex = at;
    const m = pattern.exec(text);
    if (!m) return null;
    const value = toIso(m);
    return value ? { value, length: m[0].length } : null;
  };
  const fullYear = (y: string) => (y.length === 2 ? 2000 + Number(y) : Number(y));
  const month = (name: string) => MONTHS.indexOf(name.toLowerCase()) + 1;
  return (
    attempt(ISO_DATE, (m) => isoDate(Number(m[1]), Number(m[2]), Number(m[3]))) ??
    attempt(US_DATE, (m) => isoDate(fullYear(m[4]!), Number(m[1]), Number(m[3]))) ??
    attempt(NAMED_DATE, (m) => isoDate(Number(m[3]), month(m[1]!), Number(m[2]))) ??
    attempt(DAY_FIRST_DATE, (m) => isoDate(Number(m[3]), month(m[2]!), Number(m[1])))
  );
}

// 14293185, 7353530-1762-8, XX-12979980-X, *****-53037, XXXX - 6903.
const NUMBER = /[A-Za-z0-9*][A-Za-z0-9*._/-]*(?: - [A-Za-z0-9*]+)*/y;

/** An account, invoice or confirmation number: 3 to 40 characters with at least one digit, so "N/A" is not one. */
export function parseNumber(text: string, at = 0): ParsedValue | null {
  NUMBER.lastIndex = at;
  const m = NUMBER.exec(text);
  if (!m) return null;
  const shown = m[0].replace(/[._/-]+$/, "");
  if (!/\d/.test(shown) || shown.length < 3 || shown.length > 40) return null;
  return { value: shown, length: shown.length };
}

const PARSERS: Record<(typeof FIELD_TYPES)[FieldName], (text: string, at: number) => ParsedValue | null> = {
  money: parseMoney,
  date: parseDate,
  number: parseNumber,
};

// ---- Labels ---------------------------------------------------------------

/**
 * The labels billers use, per field, most trusted first. When labels of
 * different rank are both found, the more trusted one wins (a receipt's
 * Total over its Payment Amount, because the total includes any fee).
 * Drawn from the owner's real bills; see the vault's Extraction note.
 */
export const LABELS: Record<FieldName, readonly string[]> = {
  amount: [
    "Total Amount Due",
    "Amount Due",
    "Total Due",
    "Balance Due",
    "Amount Billed",
    "Bill Amount",
    "Invoice Amount",
    "Total Payment",
    "Payment Total",
    "Total",
    "Payment Amount",
    "Amount Paid",
    "Amount",
  ],
  fee: ["Convenience Fee", "Service Fee", "Processing Fee"],
  dueDate: [
    "Payment Due Date",
    "Invoice Due Date",
    "Due Date",
    "Date Due",
    "Due By",
    "Pay By",
    "Next Payment Date",
    "Next Billing Date",
    "Next Payment",
    "Renews On",
    "Renewal Date",
  ],
  paidDate: ["Payment Date", "Date Paid", "Paid On"],
  accountNo: ["Account Number", "Account No", "Account #", "Customer ID", "Customer Number"],
  invoiceNo: ["Invoice Number", "Invoice No", "Invoice #", "Bill Number", "Statement Number"],
  confirmationNo: ["Confirmation Number", "Confirmation No", "Confirmation #", "Reference Number", "Transaction ID"],
};

interface LabelPattern {
  field: FieldName;
  rank: number;
  /** The label followed by its value in the same piece. */
  inline: RegExp;
  /** The label filling its whole piece, with the value in the next piece. */
  alone: RegExp;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** "Account #" also matches "Account#"; case is ignored. Pieces already have single spaces. */
function labelSource(label: string): string {
  return label
    .split(" ")
    .map((word, i) => (i === 0 ? "" : word === "#" ? " ?" : " ") + escapeRegExp(word))
    .join("");
}

// After a label: an optional footnote asterisk and colon.
const AFTER_LABEL = " ?\\*? ?:? ?";

const PATTERNS: LabelPattern[] = FIELDS.flatMap((field) =>
  LABELS[field].map((label, rank) => {
    const source = labelSource(label);
    return {
      field,
      rank,
      inline: new RegExp(`(?<![\\p{L}\\p{N}])(${source})(?![\\p{L}\\p{N}])${AFTER_LABEL}`, "giu"),
      alone: new RegExp(`^(${source})${AFTER_LABEL}$`, "iu"),
    };
  }),
);

/** One label found with a value after it. */
interface Match {
  field: FieldName;
  rank: number;
  labelText: string;
  value: ParsedValue["value"];
  shown: string;
  spot: PickSpot;
}

function findMatches(pieces: readonly string[]): Match[] {
  const found: Match[] = [];
  pieces.forEach((piece, index) => {
    for (const pattern of PATTERNS) {
      const type = FIELD_TYPES[pattern.field];
      const parse = PARSERS[type];
      const alone = pattern.alone.exec(piece);
      if (alone) {
        const next = pieces[index + 1];
        const parsed = next === undefined ? null : parse(next, 0);
        // A number on its own must fill its piece, so "Invoice Number" followed by a sentence is not read as one.
        if (next !== undefined && parsed && (type !== "number" || parsed.length === next.length)) {
          found.push({
            field: pattern.field,
            rank: pattern.rank,
            labelText: alone[1]!,
            value: parsed.value,
            shown: next.slice(0, parsed.length),
            spot: {
              labelPiece: index,
              label: { start: 0, end: alone[1]!.length },
              valuePiece: index + 1,
              value: { start: 0, end: parsed.length },
            },
          });
        }
        continue;
      }
      for (const m of piece.matchAll(pattern.inline)) {
        const at = m.index + m[0].length;
        const parsed = parse(piece, at);
        if (!parsed) continue;
        found.push({
          field: pattern.field,
          rank: pattern.rank,
          labelText: m[1]!,
          value: parsed.value,
          shown: piece.slice(at, at + parsed.length),
          spot: {
            labelPiece: index,
            label: { start: m.index, end: m.index + m[1]!.length },
            valuePiece: index,
            value: { start: at, end: at + parsed.length },
          },
        });
      }
    }
  });
  return found;
}

/** Drops a label found inside a longer one, such as "Amount" inside "Payment Amount". */
function dropOverlaps(matches: Match[]): Match[] {
  const byPlace = [...matches].sort(
    (a, b) =>
      a.spot.labelPiece - b.spot.labelPiece ||
      a.spot.label.start - b.spot.label.start ||
      b.spot.label.end - b.spot.label.start - (a.spot.label.end - a.spot.label.start),
  );
  const kept: Match[] = [];
  for (const match of byPlace) {
    const clash = kept.some(
      (k) =>
        k.spot.labelPiece === match.spot.labelPiece &&
        k.spot.label.start < match.spot.label.end &&
        match.spot.label.start < k.spot.label.end,
    );
    if (!clash) kept.push(match);
  }
  return kept;
}

function pickFields(matches: Match[]): PickedField[] {
  const kept = dropOverlaps(matches);
  const fields: PickedField[] = [];
  for (const field of FIELDS) {
    const forField = kept.filter((m) => m.field === field);
    if (forField.length === 0) continue;
    const best = Math.min(...forField.map((m) => m.rank));
    const values = new Map<string, PickedValue>();
    for (const m of forField.filter((m) => m.rank === best)) {
      const existing = values.get(m.value);
      if (existing) existing.spots.push(m.spot);
      else values.set(m.value, { value: m.value, shown: m.shown, label: m.labelText, spots: [m.spot] });
    }
    fields.push({ field, values: [...values.values()], by: "reader" });
  }
  return fields;
}

// ---- Kind -----------------------------------------------------------------

const RECEIPT_WORDS =
  /\bpayment\b(?:[^.!?]{0,40}?)\b(?:received|posted|processed|confirmation|confirmed|successful|complete)\b|\bthank you for (?:your )?payment\b|\breceipt\b/i;
const REMINDER_WORDS = /\b(?:reminder|second notice|final notice|past due|overdue|bill (?:is )?due|due soon)\b/i;
// A heading line on its own, such as the city's "Second Notice".
const REMINDER_HEADING = /^(?:(?:second|final|past due|overdue) notice|(?:payment |bill )?reminder)$/i;

function decideKind(subject: string, pieces: readonly string[], fields: readonly PickedField[]): { kind: EmailKind; reason: string } {
  const has = (field: FieldName) => fields.some((f) => f.field === field);
  const receipt = RECEIPT_WORDS.exec(subject);
  if (receipt) return { kind: "receipt", reason: `The subject says "${receipt[0]}".` };
  const reminder = REMINDER_WORDS.exec(subject);
  if (reminder) return { kind: "reminder", reason: `The subject says "${reminder[0]}".` };
  const heading = pieces.find((piece) => REMINDER_HEADING.test(piece));
  if (heading) return { kind: "reminder", reason: `The email says "${heading}".` };
  if ((has("paidDate") || has("confirmationNo")) && !has("dueDate")) {
    return { kind: "receipt", reason: "It has a payment date or confirmation number and no due date." };
  }
  if (has("amount")) return { kind: "bill", reason: "It has an amount to pay." };
  if (has("dueDate")) return { kind: "bill", reason: "It has a due date." };
  return { kind: "statement", reason: "No amount or due date was found." };
}

// ---- Putting it together --------------------------------------------------

/** Reads one email. Prefers the HTML body; uses the plain text when the HTML gives nothing. */
export function extract(capture: Pick<Capture, "subject" | "html" | "text">): Extraction {
  let source: Extraction["source"] = null;
  let pieces: string[] = [];
  let fields: PickedField[] = [];
  if (capture.html) {
    source = "html";
    pieces = readHtml(capture.html).pieces;
    fields = pickFields(findMatches(pieces));
  }
  if (capture.text && fields.length === 0) {
    const textPieces = readText(capture.text).pieces;
    const textFields = pickFields(findMatches(textPieces));
    if (source === null || textFields.length > 0) {
      source = "text";
      pieces = textPieces;
      fields = textFields;
    }
  }
  const { kind, reason } = decideKind(capture.subject ?? "", pieces, fields);
  return { source, pieces, kind, kindReason: reason, fields };
}

/** The values shown in the list of emails. A field the email disagrees with itself on is left out. */
export function summarize(extraction: Extraction): ExtractionSummary {
  const single = (field: FieldName) => {
    const found = extraction.fields.find((f) => f.field === field);
    return found?.values.length === 1 ? found.values[0]!.value : null;
  };
  return {
    kind: extraction.kind,
    amount: single("amount"),
    dueDate: single("dueDate"),
    paidDate: single("paidDate"),
    needsCheck: extraction.fields.some((f) => f.values.length > 1),
  };
}
