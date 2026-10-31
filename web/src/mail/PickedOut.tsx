// "Picked out": what the reader found in one email (its kind, and each
// value with the label it was found by), with the email's own words around
// each value, marked, so a person can see why it was picked. When the email
// has a biller, each value has Fix, to choose the right one (see FixValue).

import { Pencil } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import type { BillerMatch } from "../../../src/shared/api";
import { FIELDS, type Extraction, type FieldName, type PickedField, type PickedValue } from "../../../src/shared/extraction";
import { Button, DetailRow, Notice } from "../components/ui";
import { plural } from "../format";
import { Said, Where } from "./EmailWords";
import { FixValue } from "./FixValue";
import { EXPECTED_FIELDS, FIELD_LABELS, formatPicked, isCredit, KIND_LABELS } from "./picked";

function ValueLine({
  field,
  value,
  pieces,
  byRule,
  inInvoice,
}: {
  field: FieldName;
  value: PickedValue;
  pieces: readonly string[];
  byRule: boolean;
  inInvoice: boolean;
}) {
  const repeats = value.spots.length;
  const where = inInvoice ? "in the invoice" : "in the email";
  return (
    <div>
      <span className="block font-medium">{formatPicked(field, value.value)}</span>
      <span className="block text-sm text-muted">
        Found after "{value.label}"{repeats > 1 ? `, ${plural(repeats, "time", "times")} ${where}` : inInvoice ? ` ${where}` : ""}
        {byRule ? ", by your rule" : ""}
      </span>
      <Where pieces={pieces} spot={value.spots[0]!} inInvoice={inInvoice} />
    </div>
  );
}

/** "Due now (past due)", with the words that say so. */
function DueNowLine({ extraction }: { extraction: Extraction }) {
  const dueNow = extraction.dueNow!;
  const inInvoice = dueNow.from === "invoice";
  const piece = (inInvoice ? extraction.invoice?.pieces : extraction.pieces)?.[dueNow.piece] ?? "";
  return (
    <div>
      <span className="block font-medium text-warn">Due now (past due)</span>
      <span className="block text-sm text-muted">
        The {inInvoice ? "invoice" : "email"} says "{dueNow.said}".
      </span>
      <Said piece={piece} start={dueNow.start} end={dueNow.end} inInvoice={inInvoice} />
    </div>
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

/** What Fix needs, when the email can be fixed. */
interface FixContext {
  captureId: string;
  biller: BillerMatch;
  pieces: readonly string[];
  invoicePieces: readonly string[];
  /** The field whose Fix is open, if any. */
  open: FieldName | null;
  setOpen: (field: FieldName | null) => void;
  onSaved: (message: string) => void;
}

/** One field's row: what was found (or not), then Fix or its panel. */
function FieldRow({ field, fix, children }: { field: FieldName; fix: FixContext | null; children: ReactNode }) {
  const name = FIELD_LABELS[field].toLowerCase();
  return (
    <DetailRow label={FIELD_LABELS[field]}>
      {children}
      {fix && fix.open === field ? (
        <FixValue
          captureId={fix.captureId}
          field={field}
          pieces={fix.pieces}
          invoicePieces={fix.invoicePieces}
          biller={fix.biller}
          onClose={() => fix.setOpen(null)}
          onSaved={fix.onSaved}
        />
      ) : null}
      {fix && fix.open !== field ? (
        <Button variant="secondary" className="mt-2 px-3 py-1" aria-label={`Fix the ${name}`} onClick={() => fix.setOpen(field)}>
          <Pencil aria-hidden className="size-4" />
          Fix
        </Button>
      ) : null}
    </DetailRow>
  );
}

/** A choice of the fields not shown above, to pick one out of the email with Fix. */
function PickAnother({ fields, onPick }: { fields: readonly FieldName[]; onPick: (field: FieldName) => void }) {
  const selectId = useId();
  if (fields.length === 0) return null;
  return (
    <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
      <label htmlFor={selectId} className="text-sm text-muted">
        Pick out something else:
      </label>
      <select
        id={selectId}
        value=""
        onChange={(e) => e.target.value && onPick(e.target.value as FieldName)}
        className="min-w-0 max-w-full rounded-md border border-line bg-surface px-3 py-1.5 text-sm text-ink"
      >
        <option value="">Choose a value...</option>
        {fields.map((field) => (
          <option key={field} value={field}>
            {FIELD_LABELS[field]}
          </option>
        ))}
      </select>
    </div>
  );
}

export function PickedOut({
  extraction,
  captureId,
  biller = null,
}: {
  extraction: Extraction;
  /** The email's id; with a biller, it turns on Fix. */
  captureId?: string;
  biller?: BillerMatch | null;
}) {
  const headingId = useId();
  const [open, setOpen] = useState<FieldName | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const { fields, kind, kindReason, pieces } = extraction;
  const found = new Set(fields.map((f) => f.field));
  const dueNow = extraction.dueNow !== null;
  // A past due bill is due now: its due date is not missing, even when it prints none.
  const missing = EXPECTED_FIELDS[kind].filter((field) => !found.has(field) && !(field === "dueDate" && dueNow));
  const dueNowRow = dueNow && !found.has("dueDate");
  const conflicts = fields.filter((f) => f.values.length > 1);
  const credit = isCredit(fields.find((f) => f.field === "amount"));
  const byRule = fields.some((f) => f.by === "rule");

  const canFix = captureId !== undefined && biller !== null && extraction.source !== null;
  const fix: FixContext | null = canFix
    ? {
        captureId,
        biller,
        pieces,
        invoicePieces: extraction.invoice?.pieces ?? [],
        open,
        setOpen: (field) => {
          setSaved(null);
          setOpen(field);
        },
        onSaved: (message) => {
          setOpen(null);
          setSaved(message);
        },
      }
    : null;
  const shown = new Set<FieldName>([...found, ...missing, ...(dueNowRow ? (["dueDate"] as const) : [])]);
  // A field picked from "Pick out something else" gets a row while its Fix is open.
  const extra = fix && open !== null && !shown.has(open) ? open : null;
  const others = FIELDS.filter((field) => !shown.has(field) && field !== extra);

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
        {saved ? (
          <Notice tone="info" live>
            {saved}
          </Notice>
        ) : null}
        {kind === "reminder" ? (
          <Notice tone="info">
            A reminder of a bill already sent. Reminders are not sent to OurHome, so the bill is not counted twice.
          </Notice>
        ) : null}
        {credit ? <Notice tone="info">This is a credit: nothing is owed. Credits are not sent to OurHome.</Notice> : null}
        {extraction.dueNow ? (
          <Notice tone="warning">
            This bill is past due: the {extraction.dueNow.from === "invoice" ? "invoice" : "email"} says "{extraction.dueNow.said}". It is due now.
          </Notice>
        ) : null}
        {conflicts.map((field) => (
          <Conflict key={field.field} field={field} />
        ))}
      </div>

      {fields.length || missing.length || extra || dueNowRow ? (
        <dl className="mt-2 divide-y divide-line">
          {fields.map((field) => (
            <FieldRow key={field.field} field={field.field} fix={fix}>
              <div className="flex flex-col gap-3">
                {field.field === "dueDate" && dueNow ? (
                  <>
                    <DueNowLine extraction={extraction} />
                    <span className="text-sm text-muted">It also gives a date:</span>
                  </>
                ) : null}
                {field.values.map((value) => (
                  <ValueLine
                    key={value.value}
                    field={field.field}
                    value={value}
                    pieces={field.from === "invoice" ? (extraction.invoice?.pieces ?? []) : pieces}
                    byRule={field.by === "rule"}
                    inInvoice={field.from === "invoice"}
                  />
                ))}
              </div>
            </FieldRow>
          ))}
          {dueNowRow ? (
            <FieldRow field="dueDate" fix={fix}>
              <DueNowLine extraction={extraction} />
            </FieldRow>
          ) : null}
          {missing.map((field) => (
            <FieldRow key={field} field={field} fix={fix}>
              <span className="text-muted">Not found in this email</span>
            </FieldRow>
          ))}
          {extra ? (
            <FieldRow key={extra} field={extra} fix={fix}>
              <span className="text-muted">Not picked out yet</span>
            </FieldRow>
          ) : null}
        </dl>
      ) : (
        <p className="mt-2 text-muted">Nothing was picked out of this email.</p>
      )}
      {fix ? <PickAnother fields={others} onPick={(field) => fix.setOpen(field)} /> : null}

      <p className="mt-3 border-t border-line pt-3 text-sm text-muted">
        Found by the built-in reader, which looks for the labels billers use, such as Amount Due and Due Date
        {byRule && biller ? `, and by your rules for ${biller.name}` : ""}.
        {fix ? ` If a value is wrong or missing, use Fix: your choice is used for every email from ${biller!.name}.` : ""}
        {captureId !== undefined && biller === null ? " To fix a value, first add this email's sender to a biller." : ""}
        {extraction.source === "html" ? " Each value is also marked in the Email tab." : ""}
        {extraction.source === "text" ? " Each value is also marked in the Text tab." : ""}
        {fields.some((f) => f.from === "invoice") ? " Values found in the invoice are marked in the Invoice tab." : ""}
      </p>
    </section>
  );
}
