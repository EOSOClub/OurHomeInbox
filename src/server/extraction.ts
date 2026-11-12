// The built-in reader: picks the amount, dates and numbers out of a bill
// email by the labels billers put beside them ("Amount Due: $114.93", or
// "Amount Billed:" in one table cell and "$4.13" in the next), and decides
// whether the email is a bill, a reminder, a receipt, a statement or a
// payment that failed. A
// biller's rules (saved with Fix) add labels of its own, tried first, or,
// for a rule used only where nothing else gives the field, tried last; Fix
// itself is choicesFor, at the end.
//
// The email's text is only ever matched against these patterns. Nothing in
// it is followed, run, or treated as an instruction.

import { parse, type DefaultTreeAdapterMap } from "parse5";
import type { Capture } from "../shared/capture.js";
import {
  FIELDS,
  FIELD_TYPES,
  MAX_RULE_LABEL,
  type BillerRule,
  type DueNow,
  type EmailKind,
  type Extraction,
  type ExtractionSummary,
  type FieldChoice,
  type FieldName,
  type InvoiceText,
  type PickedField,
  type PickedValue,
  type PickSpot,
  type PiecePlace,
  type RuleWhen,
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

// 14293185, 7353530-1762-8, XX-12979980-X, *****-53037, XXXX - 6903. Billers
// also join the parts with an en or em dash ("XXXX – 6903"), so those are
// read as hyphens.
const NUMBER = /[A-Za-z0-9*][A-Za-z0-9*._/–—-]*(?: [–—-] [A-Za-z0-9*]+)*/y;
const OTHER_DASH = /[–—]/g;

/**
 * An account, invoice or confirmation number: 3 to 40 characters with at
 * least one digit, so "N/A" is not one. Its value has plain hyphens for any
 * en or em dash it was printed with.
 */
export function parseNumber(text: string, at = 0): ParsedValue | null {
  NUMBER.lastIndex = at;
  const m = NUMBER.exec(text);
  if (!m) return null;
  const shown = m[0].replace(/[._/–—-]+$/, "");
  if (!/\d/.test(shown) || shown.length < 3 || shown.length > 40) return null;
  return { value: shown.replace(OTHER_DASH, "-"), length: shown.length };
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
    "Total Due By",
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
  /** Lower is more trusted. A biller's rule is -1, ahead of every built-in label. */
  rank: number;
  byRule: boolean;
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

function labelPattern(field: FieldName, label: string, rank: number, byRule: boolean): LabelPattern {
  const source = labelSource(label);
  return {
    field,
    rank,
    byRule,
    inline: new RegExp(`(?<![\\p{L}\\p{N}])(${source})(?![\\p{L}\\p{N}])${AFTER_LABEL}`, "giu"),
    alone: new RegExp(`^(${source})${AFTER_LABEL}$`, "iu"),
  };
}

const PATTERNS: LabelPattern[] = FIELDS.flatMap((field) => LABELS[field].map((label, rank) => labelPattern(field, label, rank, false)));

/**
 * A biller's rules as label patterns: `first`, the rules used always, more
 * trusted than any built-in label; `fallback`, the rules used only for a
 * field nothing else gives (RuleWhen "missing").
 */
interface RulePatterns {
  first: LabelPattern[];
  fallback: LabelPattern[];
}

function rulePatterns(rules: readonly BillerRule[]): RulePatterns {
  return {
    first: rules.filter((rule) => rule.when !== "missing").map((rule) => labelPattern(rule.field, rule.label, -1, true)),
    // In the order saved, each more trusted than the next, so the first one found gives the field (and two never disagree).
    fallback: rules
      .filter((rule) => rule.when === "missing")
      .map((rule, order) => labelPattern(rule.field, rule.label, -1_000_000 + order, true)),
  };
}

/** One label found with a value after it. */
interface Match {
  field: FieldName;
  rank: number;
  byRule: boolean;
  labelText: string;
  value: ParsedValue["value"];
  shown: string;
  spot: PickSpot;
}

/**
 * Every label in the pieces with a value after it. `below` (an invoice's
 * layout) also lets a label's value be in the piece just below it.
 */
function findMatches(
  pieces: readonly string[],
  patterns: readonly LabelPattern[] = PATTERNS,
  below: ReadonlyArray<number | null> = [],
): Match[] {
  const found: Match[] = [];
  pieces.forEach((piece, index) => {
    for (const pattern of patterns) {
      const type = FIELD_TYPES[pattern.field];
      const parse = PARSERS[type];
      const alone = pattern.alone.exec(piece);
      if (alone) {
        for (const valuePiece of new Set([index + 1, below[index] ?? index + 1])) {
          const next = pieces[valuePiece];
          const parsed = next === undefined ? null : parse(next, 0);
          // A number on its own must fill its piece, so "Invoice Number" followed by a sentence is not read as one.
          if (next === undefined || !parsed || (type === "number" && parsed.length !== next.length)) continue;
          found.push({
            field: pattern.field,
            rank: pattern.rank,
            byRule: pattern.byRule,
            labelText: alone[1]!,
            value: parsed.value,
            shown: next.slice(0, parsed.length),
            spot: {
              labelPiece: index,
              label: { start: 0, end: alone[1]!.length },
              valuePiece,
              value: { start: 0, end: parsed.length },
            },
          });
          break;
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
          byRule: pattern.byRule,
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

/**
 * Drops a label found inside a longer one, such as "Amount" inside "Payment
 * Amount". Where a rule and a built-in label are the same words (a rule
 * saying "Payment Date" is the due date), the rule keeps them.
 */
function dropOverlaps(matches: Match[]): Match[] {
  const byPlace = [...matches].sort(
    (a, b) =>
      a.spot.labelPiece - b.spot.labelPiece ||
      a.spot.label.start - b.spot.label.start ||
      b.spot.label.end - b.spot.label.start - (a.spot.label.end - a.spot.label.start) ||
      Number(b.byRule) - Number(a.byRule),
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

function pickFields(matches: Match[], from: PickedField["from"]): PickedField[] {
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
    fields.push({ field, values: [...values.values()], by: best < 0 ? "rule" : "reader", from });
  }
  return fields;
}

// ---- Kind -----------------------------------------------------------------

const RECEIPT_WORDS =
  /\bpayment\b(?:[^.!?]{0,40}?)\b(?:received|posted|processed|confirmation|confirmed|successful|complete)\b|\bthank you for (?:your )?payment\b|\breceipt\b/i;
const REMINDER_WORDS = /\b(?:reminder|second notice|final notice|past due|overdue|bill (?:is )?due|due soon)\b/i;
// A heading line on its own, such as the city's "Second Notice".
const REMINDER_HEADING = /^(?:(?:second|final|past due|overdue) notice|(?:payment |bill )?reminder)$/i;

// A payment that did not go through. Looked for before the receipt words,
// which "Your payment could not be processed" and "Payment not received"
// also hold: read as a receipt, a failed payment would pair with its bill and
// reach OurHome as paid (found 2026-11-11).
const FAILED_WORD = "failed|declined|unsuccessful|returned|reversed|rejected";
const NOT = "(?:\\bnot\\b|n['’]t\\b|\\bunable to be\\b)";
const FAILED_WORDS = new RegExp(
  [
    // "payment failed", "your payment was declined", "payment has been returned"
    `\\bpayment\\b[^.!?]{0,40}?\\b(?:${FAILED_WORD})\\b`,
    // "payment could not be processed", "payment not received", "payment was not successful", "payment didn't go through"
    `\\bpayment\\b[^.!?]{0,30}?${NOT}[^.!?]{0,15}?\\b(?:received|posted|processed|successful|completed?|accepted|made|go through)\\b`,
    // "failed payment", "declined payment", "payment failure"
    `\\b(?:${FAILED_WORD}) payment\\b`,
    "\\bpayment (?:failure|error)\\b",
    // "we were unable to process your payment", "we could not take your payment"
    "\\b(?:unable to|could not|couldn['’]t|cannot|can['’]t|failed to) (?:process|complete|accept|take|collect)\\b[^.!?]{0,20}?\\bpayment\\b",
  ].join("|"),
  "i",
);
// A heading line on its own, such as "Payment Declined". Only a whole line counts: fine print such as
// "Returned payment fee: $30.00" or "If your payment is declined..." says nothing about this payment.
const FAILED_HEADING = new RegExp(
  `^(?:your )?(?:(?:auto ?pay )?payment (?:has |was |is )?(?:${FAILED_WORD}|not (?:been )?(?:received|processed|successful|completed?|accepted))|(?:${FAILED_WORD}) payment|payment (?:failure|error))[.!]?$`,
  "i",
);
// A payment that has not been made yet: "Your payment is scheduled", "Your
// payment will be processed on Nov 5", "Upcoming AutoPay payment". Not "was
// processed as scheduled", which says it was made.
const SCHEDULED_WORDS =
  /\bpayment\b[^.!?]{0,40}?\b(?:(?<!\bas )scheduled|pending|will be)\b|\bupcoming\b[^.!?]{0,20}?\bpayment\b|\bwill be (?:processed|made|withdrawn|deducted|charged|drafted|debited|taken|paid)\b/i;

function decideKind(subject: string, pieces: readonly string[], fields: readonly PickedField[]): { kind: EmailKind; reason: string } {
  const has = (field: FieldName) => fields.some((f) => f.field === field);
  const failed = FAILED_WORDS.exec(subject);
  if (failed) return { kind: "failed", reason: `The subject says "${failed[0]}": the payment did not go through.` };
  const failedHeading = pieces.find((piece) => FAILED_HEADING.test(piece));
  if (failedHeading) return { kind: "failed", reason: `The email says "${failedHeading}": the payment did not go through.` };
  // Where the email would otherwise be a receipt, a payment still to come makes it a reminder: nothing has been paid yet.
  const scheduled = SCHEDULED_WORDS.exec(subject);
  const notYet = (words: string) => ({ kind: "reminder" as const, reason: `The subject says "${words}": the payment has not been made yet.` });
  const receipt = RECEIPT_WORDS.exec(subject);
  if (receipt && scheduled) return notYet(scheduled[0]);
  if (receipt) return { kind: "receipt", reason: `The subject says "${receipt[0]}".` };
  const reminder = REMINDER_WORDS.exec(subject);
  if (reminder) return { kind: "reminder", reason: `The subject says "${reminder[0]}".` };
  const heading = pieces.find((piece) => REMINDER_HEADING.test(piece));
  if (heading) return { kind: "reminder", reason: `The email says "${heading}".` };
  if ((has("paidDate") || has("confirmationNo")) && !has("dueDate")) {
    if (scheduled) return notYet(scheduled[0]);
    return { kind: "receipt", reason: "It has a payment date or confirmation number and no due date." };
  }
  if (has("amount")) return { kind: "bill", reason: "It has an amount to pay." };
  if (has("dueDate")) return { kind: "bill", reason: "It has a due date." };
  return { kind: "statement", reason: "No amount or due date was found." };
}

// ---- Past due -------------------------------------------------------------

// "Your account is Past Due.", "This bill is now overdue". Only a statement
// about this account counts: fine print such as "All past due amounts are due
// immediately" (in every one of the city's emails) says nothing about it.
const PAST_DUE_SENTENCE = /\b(?:your|this|the)\s+(?:account|payment|bill|balance|invoice)\s+(?:is|was|has become)\s+(?:now\s+)?(?:past[\s-]?due|overdue)\b/i;
// "Past Due" or "Overdue" on its own, as a heading.
const PAST_DUE_HEADING = /^(?:account\s+)?(?:past[\s-]?due|overdue)!?$/i;
// "Past Due Amount: $25.00"; a past due amount of $0.00 means nothing is.
const PAST_DUE_AMOUNT = /\b(?:past[\s-]?due(?:\s+(?:amount|balance))?|amount\s+past[\s-]?due|overdue\s+(?:amount|balance))\s?\*?\s?:?\s?/gi;

// Words that make what follows in the sentence a condition, not a fact: "pay before your bill is past due".
const CONDITION = /\b(?:before|if|when|until|unless|once|avoid|prevent|so that)\b/i;

/** Where the pieces say the account is past due, or null. */
function findPastDue(pieces: readonly string[], from: DueNow["from"]): DueNow | null {
  for (const [piece, text] of pieces.entries()) {
    const sentence = PAST_DUE_SENTENCE.exec(text);
    const sentenceStart = sentence ? Math.max(text.lastIndexOf(".", sentence.index), text.lastIndexOf("!", sentence.index), text.lastIndexOf("?", sentence.index)) + 1 : 0;
    if (sentence && !CONDITION.test(text.slice(sentenceStart, sentence.index))) {
      return { from, piece, start: sentence.index, end: sentence.index + sentence[0].length, said: sentence[0] };
    }
    if (PAST_DUE_HEADING.test(text)) return { from, piece, start: 0, end: text.length, said: text };
    for (const label of text.matchAll(PAST_DUE_AMOUNT)) {
      const at = label.index + label[0].length;
      const amount = parseMoney(text, at);
      if (amount && Number(amount.value) > 0) {
        return { from, piece, start: label.index, end: at + amount.length, said: text.slice(label.index, at + amount.length) };
      }
    }
  }
  return null;
}

// ---- Putting it together --------------------------------------------------

/** One body as pieces, with what the built-in labels found in it. */
interface ReadBody {
  source: "html" | "text" | "invoice";
  pieces: string[];
  /** An invoice's layout: the piece just below each piece. Empty for an email's body. */
  below: ReadonlyArray<number | null>;
  builtIn: Match[];
}

function readBody(source: ReadBody["source"], pieces: string[], below: ReadonlyArray<number | null> = []): ReadBody {
  return { source, pieces, below, builtIn: findMatches(pieces, PATTERNS, below) };
}

/**
 * An email read once (with its invoice, when its link gave one), ready to be
 * picked from with any rules. Reading is the slow part; trying a rule only
 * looks for its one label.
 */
export class PreparedEmail {
  readonly subject: string;
  readonly html: ReadBody | null;
  readonly invoice: (ReadBody & { places: PiecePlace[] }) | null;
  private readonly textBody: string | null;
  private text: ReadBody | null | undefined;

  constructor(capture: Pick<Capture, "subject" | "html" | "text">, invoice: InvoiceText | null = null) {
    this.subject = capture.subject ?? "";
    this.html = capture.html ? readBody("html", readHtml(capture.html).pieces) : null;
    this.textBody = capture.text;
    this.invoice = invoice ? { ...readBody("invoice", invoice.pieces, invoice.below), places: invoice.places } : null;
  }

  /** The plain text body, read the first time it is needed. */
  textReading(): ReadBody | null {
    if (this.text === undefined) this.text = this.textBody ? readBody("text", readText(this.textBody).pieces) : null;
    return this.text;
  }
}

function pick(body: ReadBody, rules: readonly LabelPattern[]): PickedField[] {
  const from = body.source === "invoice" ? "invoice" : "email";
  return pickFields(rules.length ? [...body.builtIn, ...findMatches(body.pieces, rules, body.below)] : body.builtIn, from);
}

/**
 * The email's own fields and its invoice's, one per field: the email's,
 * unless it lacks the field or only the invoice's was found by a rule.
 */
function merge(email: PickedField[], invoice: PickedField[]): PickedField[] {
  return FIELDS.flatMap((field) => {
    const own = email.find((f) => f.field === field);
    const other = invoice.find((f) => f.field === field);
    if (other && (!own || (other.by === "rule" && own.by !== "rule"))) return [other];
    return own ? [own] : [];
  });
}

/**
 * The fields the fallback rules give where nothing else gave them: from the
 * email's body first, then its invoice. Built-in labels are looked at with
 * them only so a rule's words inside a longer label are not taken.
 */
function fillMissing(fields: PickedField[], bodies: ReadonlyArray<ReadBody | null>, fallback: readonly LabelPattern[]): PickedField[] {
  let filled = fields;
  for (const body of bodies) {
    const missing = fallback.filter((pattern) => !filled.some((f) => f.field === pattern.field));
    if (!body || missing.length === 0) continue;
    const from = body.source === "invoice" ? "invoice" : "email";
    const found = pickFields([...body.builtIn, ...findMatches(body.pieces, missing, body.below)], from).filter(
      (f) => f.by === "rule" && missing.some((pattern) => pattern.field === f.field),
    );
    if (found.length > 0) filled = FIELDS.flatMap((field) => [...filled, ...found].filter((f) => f.field === field));
  }
  return filled;
}

/**
 * Prefers the HTML body; uses the plain text when the HTML gives nothing. Then
 * adds the invoice's, and last what the fallback rules give for fields still
 * missing.
 */
function finishWith(email: PreparedEmail, rules: RulePatterns): Extraction {
  let source: Extraction["source"] = null;
  let pieces: string[] = [];
  let fields: PickedField[] = [];
  let body: ReadBody | null = null;
  if (email.html) {
    source = "html";
    pieces = email.html.pieces;
    fields = pick(email.html, rules.first);
    body = email.html;
  }
  const text = fields.length === 0 ? email.textReading() : null;
  if (text) {
    const textFields = pick(text, rules.first);
    if (source === null || textFields.length > 0) {
      source = "text";
      pieces = text.pieces;
      fields = textFields;
      body = text;
    }
  }
  if (email.invoice) fields = merge(fields, pick(email.invoice, rules.first));
  if (rules.fallback.length > 0) fields = fillMissing(fields, [body, email.invoice], rules.fallback);
  const { kind, reason } = decideKind(email.subject, pieces, fields);
  const invoice = email.invoice ? { pieces: email.invoice.pieces, places: email.invoice.places } : null;
  const dueNow = findPastDue(pieces, "email") ?? (email.invoice ? findPastDue(email.invoice.pieces, "invoice") : null);
  return { source, pieces, kind, kindReason: reason, fields, invoice, dueNow };
}

/** What a prepared email gives with its biller's rules (none when it has no biller). */
export function finish(email: PreparedEmail, rules: readonly BillerRule[] = []): Extraction {
  return finishWith(email, rulePatterns(rules));
}

/** Reads one email, with its biller's rules and the invoice its link gave. */
export function extract(
  capture: Pick<Capture, "subject" | "html" | "text">,
  rules: readonly BillerRule[] = [],
  invoice: InvoiceText | null = null,
): Extraction {
  return finish(new PreparedEmail(capture, invoice), rules);
}

// ---- Fix: the values a person can choose from -----------------------------

/** A value of the field's kind in the email, with the words before it that could be its label. */
interface Candidate {
  piece: number;
  start: number;
  label: string;
}

// A label is letters and a little punctuation, never digits: a label holding
// a date or a number would not be in next month's email.
const LABEL_TAIL = /\p{L}[\p{L}\p{M} #&'./-]*$/u;
const WHOLE_LABEL = /^\p{L}[\p{L}\p{M} #&'./()-]*$/u;
const LABEL_END = / ?\*? ?:? ?$/;
const LABEL_WORDS = 5;
// How far back the words before a value are looked at.
const LABEL_REACH = 80;
// More labels than this in one email are not offered.
const MAX_LABELS_TRIED = 60;

/** The last few words before a value in the same piece, as a label, or null. */
function labelBefore(before: string): string | null {
  const near = before.replace(LABEL_END, "").slice(-LABEL_REACH);
  const tail = LABEL_TAIL.exec(near);
  if (!tail) return null;
  let words = tail[0].split(/[.!?] /).pop()!.split(" ").filter(Boolean);
  // A cut-off first word is not a word.
  if (tail.index === 0 && before.length > LABEL_REACH) words = words.slice(1);
  const label = words.slice(-LABEL_WORDS).join(" ").replace(/^[^\p{L}]+/u, "");
  return label.length >= 2 && label.length <= MAX_RULE_LABEL ? label : null;
}

/** A whole piece as the label of the value in the next piece, or null. */
function labelAlone(piece: string): string | null {
  const label = piece.replace(LABEL_END, "");
  if (label.length < 2 || label.length > MAX_RULE_LABEL || !WHOLE_LABEL.test(label)) return null;
  return label.split(" ").length <= LABEL_WORDS + 3 ? label : null;
}

/**
 * Values of the field's kind with a label before them. A value that starts
 * its piece can take its label from the piece before or, in an invoice, the
 * piece above (`below` turned around).
 */
function candidates(pieces: readonly string[], field: FieldName, below: ReadonlyArray<number | null> = []): Candidate[] {
  const type = FIELD_TYPES[field];
  const parse = PARSERS[type];
  const above = new Map<number, number>();
  below.forEach((under, index) => {
    if (under !== null && !above.has(under)) above.set(under, index);
  });
  const found: Candidate[] = [];
  pieces.forEach((piece, index) => {
    for (let at = 0; at < piece.length; ) {
      const before = at === 0 ? "" : piece[at - 1]!;
      // Numbers start after a space or a label's mark, so the cents of "$4.13" are not one.
      // Never on a space: "$ 60.00" may start with one, but the value itself starts after it.
      const starts =
        piece[at] !== " " && (type === "number" ? at === 0 || /[\s:#(]/.test(before) : at === 0 || !/[\p{L}\p{N}]/u.test(before));
      if (!starts) {
        at += 1;
        continue;
      }
      if (type === "number") {
        // An amount or a date is not an account or invoice number.
        const other = parseMoney(piece, at) ?? parseDate(piece, at);
        if (other) {
          at += other.length;
          continue;
        }
      }
      const parsed = parse(piece, at);
      if (!parsed) {
        at += 1;
        continue;
      }
      if (at > 0) {
        const label = labelBefore(piece.slice(0, at));
        if (label) found.push({ piece: index, start: at, label });
      } else {
        for (const labelPiece of new Set([index - 1, above.get(index) ?? index - 1])) {
          const label = labelPiece >= 0 ? labelAlone(pieces[labelPiece]!) : null;
          if (label) found.push({ piece: index, start: at, label });
        }
      }
      at += parsed.length;
    }
  });
  return found;
}

function valuesOf(extraction: Extraction, field: FieldName): PickedValue[] {
  return extraction.fields.find((f) => f.field === field)?.values ?? [];
}

function sameValues(a: readonly PickedValue[], b: readonly PickedValue[]): boolean {
  return a.length === b.length && a.every((v, i) => v.value === b[i]!.value);
}

/**
 * Every value Fix can offer for `field` in this email: each value of the
 * right kind with a label before it, where a rule on that label really does
 * pick it. With each, how many of the biller's `others` emails the rule would
 * change. `rules` are the biller's rules now; each choice is tried with them
 * as saving it would leave them (see savedWith), always and, where nothing
 * else gives the field here, only where nothing else does.
 */
export function choicesFor(
  email: PreparedEmail,
  field: FieldName,
  rules: readonly BillerRule[],
  others: readonly PreparedEmail[],
): FieldChoice[] {
  const now = finish(email, rules);
  const emailBody = now.source === "html" ? email.html : now.source === "text" ? email.textReading() : null;
  const bodies = [emailBody, email.invoice].filter((body): body is ReadBody => body !== null);
  const pickedField = now.fields.find((f) => f.field === field);
  const picked = pickedField?.values ?? [];
  const pickedLabel = picked[0]?.label.toLowerCase();
  const othersNow = others.map((other) => valuesOf(finish(other, rules), field));
  // The biller's rules with one on `label` saved `when`, as saving it would leave them (see rules.ts):
  // a rule on the same words is replaced, and an "always" one replaces the field's "always" one.
  const savedWith = (label: string, when: RuleWhen): BillerRule[] => [
    ...rules.filter(
      (rule) => rule.field !== field || (rule.label.toLowerCase() !== label.toLowerCase() && !(when === "always" && rule.when !== "missing")),
    ),
    { field, label, when },
  ];
  // Nothing but a "missing" rule gives the field here: a new one, tried after those, may then give it.
  const missingHere = valuesOf(finish(email, rules.filter((rule) => rule.field !== field || rule.when !== "missing")), field).length === 0;
  const changed = (patterns: RulePatterns) =>
    others.filter((other, i) => !sameValues(valuesOf(finishWith(other, patterns), field), othersNow[i]!)).length;

  // What a rule on each label gives, worked out once per label.
  const tried = new Map<string, { values: PickedValue[]; from: PickedField["from"]; changes: number; changesWhenMissing: number | null } | null>();
  const tryLabel = (label: string) => {
    const key = label.toLowerCase();
    if (!tried.has(key)) {
      if (tried.size >= MAX_LABELS_TRIED) return null;
      const patterns = rulePatterns(savedWith(label, "always"));
      const result = finishWith(email, patterns);
      const found = result.fields.find((f) => f.field === field);
      // A rule that would make the reader switch bodies is not offered: its marks would point elsewhere.
      const values = result.source === now.source ? (found?.values ?? []) : [];
      let changesWhenMissing: number | null = null;
      if (missingHere && values.length > 0) {
        const fallback = rulePatterns(savedWith(label, "missing"));
        const there = finishWith(email, fallback);
        if (there.source === now.source && sameValues(valuesOf(there, field), values)) changesWhenMissing = changed(fallback);
      }
      tried.set(key, values.length && found ? { values, from: found.from, changes: changed(patterns), changesWhenMissing } : null);
    }
    return tried.get(key) ?? null;
  };

  const choices = new Map<string, FieldChoice>();
  for (const body of bodies) {
    const from = body.source === "invoice" ? "invoice" : "email";
    for (const candidate of candidates(body.pieces, field, body.below)) {
      const result = tryLabel(candidate.label);
      if (!result || result.from !== from) continue;
      const value = result.values.find((v) => v.spots.some((s) => s.valuePiece === candidate.piece && s.value.start === candidate.start));
      const key = `${from}|${candidate.label.toLowerCase()}|${value?.value}`;
      if (!value || choices.has(key)) continue;
      choices.set(key, {
        label: candidate.label,
        from,
        value,
        current: sameValues(result.values, picked) && candidate.label.toLowerCase() === pickedLabel && from === pickedField?.from,
        valuesHere: result.values.length,
        changes: result.changes,
        changesWhenMissing: result.changesWhenMissing,
      });
    }
  }
  return [...choices.values()];
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
    dueNow: extraction.dueNow !== null,
    needsCheck: extraction.fields.some((f) => f.values.length > 1),
    values: Object.fromEntries(extraction.fields.map((f) => [f.field, f.values.map((v) => v.value)])),
  };
}
