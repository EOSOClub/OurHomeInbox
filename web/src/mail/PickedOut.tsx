// "Picked out": what the reader found in one email (its kind, and each
// value with the label it was found by), with the email's own words around
// each value, marked, so a person can see why it was picked.

import { useId } from "react";
import type { Extraction, FieldName, PickedField, PickedValue, PickSpot } from "../../../src/shared/extraction";
import { DetailRow, Notice } from "../components/ui";
import { plural } from "../format";
import { segmentText, type TextHighlight } from "./highlight";
import { around, EXPECTED_FIELDS, FIELD_LABELS, formatPicked, isCredit, KIND_LABELS } from "./picked";
import { highlightClasses } from "./TextBlock";

/** A piece of the email with some ranges marked, shortened around the first mark. */
function Snippet({ piece, highlights }: { piece: string; highlights: TextHighlight[] }) {
  const first = Math.min(...highlights.map((h) => h.start));
  const last = Math.max(...highlights.map((h) => h.end));
  const { text, offset } = around(piece, first, last);
  const shifted = highlights.map((h) => ({ ...h, start: h.start - offset, end: h.end - offset }));
  return (
    <>
      {segmentText(text, shifted).map((segment, index) =>
        segment.highlight ? (
          <mark key={index} className={highlightClasses(segment.highlight.tone)}>
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

/** Where a value was found: its label and the value, in the email's words. */
function Where({ pieces, spot }: { pieces: readonly string[]; spot: PickSpot }) {
  const label: TextHighlight = { ...spot.label, tone: "label" };
  const value: TextHighlight = { ...spot.value, tone: "value" };
  const labelPiece = pieces[spot.labelPiece] ?? "";
  const valuePiece = pieces[spot.valuePiece] ?? "";
  return (
    <span className="mt-1 block rounded-md border border-line bg-surface-muted px-2 py-1 font-mono text-xs leading-relaxed wrap-anywhere">
      <span className="sr-only">In the email: </span>
      {spot.labelPiece === spot.valuePiece ? (
        <Snippet piece={labelPiece} highlights={[label, value]} />
      ) : (
        <>
          <Snippet piece={labelPiece} highlights={[label]} />
          <span aria-hidden className="px-1.5 text-muted">
            |
          </span>
          <Snippet piece={valuePiece} highlights={[value]} />
        </>
      )}
    </span>
  );
}

function ValueLine({ field, value, pieces }: { field: FieldName; value: PickedValue; pieces: readonly string[] }) {
  const repeats = value.spots.length;
  return (
    <div>
      <span className="block font-medium">{formatPicked(field, value.value)}</span>
      <span className="block text-sm text-muted">
        Found after "{value.label}"{repeats > 1 ? `, ${plural(repeats, "time", "times")} in the email` : ""}
      </span>
      <Where pieces={pieces} spot={value.spots[0]!} />
    </div>
  );
}

function FieldRow({ field, pieces }: { field: PickedField; pieces: readonly string[] }) {
  return (
    <DetailRow label={FIELD_LABELS[field.field]}>
      <div className="flex flex-col gap-3">
        {field.values.map((value) => (
          <ValueLine key={value.value} field={field.field} value={value} pieces={pieces} />
        ))}
      </div>
    </DetailRow>
  );
}

function Conflict({ field }: { field: PickedField }) {
  const shown = field.values.map((v) => formatPicked(field.field, v.value));
  const name = FIELD_LABELS[field.field].toLowerCase();
  return (
    <Notice tone="warning">
      This email gives more than one {name}: {shown.join(" and ")}. Check the email to see which is right.
    </Notice>
  );
}

export function PickedOut({ extraction }: { extraction: Extraction }) {
  const headingId = useId();
  const { fields, kind, kindReason, pieces } = extraction;
  const found = new Set(fields.map((f) => f.field));
  const missing = EXPECTED_FIELDS[kind].filter((field) => !found.has(field));
  const conflicts = fields.filter((f) => f.values.length > 1);
  const credit = isCredit(fields.find((f) => f.field === "amount"));

  return (
    <section aria-labelledby={headingId} className="rounded-lg border border-line bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id={headingId} className="text-lg font-semibold">
          Picked out
        </h2>
        <span className="rounded-full border border-line bg-surface-muted px-2.5 py-0.5 text-sm font-medium">
          {KIND_LABELS[kind]}
        </span>
      </div>
      <p className="mt-1 text-sm text-muted">{kindReason}</p>

      <div className="mt-3 flex flex-col gap-2 empty:hidden">
        {kind === "reminder" ? (
          <Notice tone="info">
            A reminder of a bill already sent. Reminders are not sent to OurHome, so the bill is not counted twice.
          </Notice>
        ) : null}
        {credit ? <Notice tone="info">This is a credit: nothing is owed. Credits are not sent to OurHome.</Notice> : null}
        {conflicts.map((field) => (
          <Conflict key={field.field} field={field} />
        ))}
      </div>

      {fields.length || missing.length ? (
        <dl className="mt-2 divide-y divide-line">
          {fields.map((field) => (
            <FieldRow key={field.field} field={field} pieces={pieces} />
          ))}
          {missing.map((field) => (
            <DetailRow key={field} label={FIELD_LABELS[field]}>
              <span className="text-muted">Not found in this email</span>
            </DetailRow>
          ))}
        </dl>
      ) : (
        <p className="mt-2 text-muted">Nothing was picked out of this email.</p>
      )}

      <p className="mt-3 border-t border-line pt-3 text-sm text-muted">
        Found by the built-in reader, which looks for the labels billers use, such as Amount Due and Due Date.
        {extraction.source === "html" ? " Each value is also marked in the Email tab." : ""}
        {extraction.source === "text" ? " Each value is also marked in the Text tab." : ""}
      </p>
    </section>
  );
}
