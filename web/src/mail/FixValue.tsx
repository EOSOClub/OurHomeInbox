// Fix: choosing the right value for one field of an email. Lists each value
// of the right kind in the email with the words before it; choosing one saves
// a rule on the biller ("the amount is the value after Current Charges"),
// used for every email from that biller, past and future.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import type { BillerMatch } from "../../../src/shared/api";
import { FIELD_TYPES, type FieldChoice, type FieldName } from "../../../src/shared/extraction";
import { api } from "../api";
import { Button, ErrorState, LoadingState, Notice } from "../components/ui";
import { plural } from "../format";
import { refreshAfterRuleChange, useChoices } from "../queries";
import { Where } from "./EmailWords";
import { FIELD_LABELS, formatPicked } from "./picked";

const KIND_OF_VALUE = { money: "an amount of money", date: "a date", number: "a number" } as const;

const choiceKey = (choice: FieldChoice) => `${choice.from}|${choice.label.toLowerCase()}|${choice.value.value}`;

/** What saving `choice` would do, in plain words. */
function Effect({ choice, field, biller, otherEmails }: { choice: FieldChoice; field: FieldName; biller: BillerMatch; otherEmails: number }) {
  const name = FIELD_LABELS[field].toLowerCase();
  let reach: string;
  if (otherEmails === 0) reach = `There are no other emails from ${biller.name} yet. New ones will use it too.`;
  else if (choice.changes === 0) reach = `It changes nothing in the other ${plural(otherEmails, "email", "emails")} from ${biller.name}.`;
  else reach = `It changes the ${name} in ${plural(choice.changes, "other email", "other emails")} from ${biller.name}.`;
  return (
    <div className="flex flex-col gap-2">
      <Notice tone="info" live>
        {reach}
      </Notice>
      {choice.valuesHere > 1 ? (
        <Notice tone="warning">
          The words "{choice.label}" come before {choice.valuesHere} different values in this email, so it would still need a check.
        </Notice>
      ) : null}
    </div>
  );
}

export function FixValue({
  captureId,
  field,
  pieces,
  invoicePieces = [],
  biller,
  onClose,
  onSaved,
}: {
  captureId: string;
  field: FieldName;
  /** The email's pieces, as in its extraction: choices from the email point into them. */
  pieces: readonly string[];
  /** The invoice's pieces: choices from the invoice point into them. */
  invoicePieces?: readonly string[];
  biller: BillerMatch;
  onClose: () => void;
  /** Called with a sentence saying what changed. */
  onSaved: (message: string) => void;
}) {
  const choices = useChoices(captureId, field);
  const queryClient = useQueryClient();
  const headingId = useId();
  const radioName = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const name = FIELD_LABELS[field].toLowerCase();

  // Keyboard and screen reader users land on the question.
  useEffect(() => heading.current?.focus(), []);

  const save = useMutation({
    mutationFn: (label: string) => api.saveBillerRule(biller.id, field, { label }),
    onSuccess: (_, label) => {
      refreshAfterRuleChange(queryClient, biller.id);
      onSaved(`Saved. The ${name} in every email from ${biller.name} is now the value after "${label}".`);
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteBillerRule(biller.id, field),
    onSuccess: () => {
      refreshAfterRuleChange(queryClient, biller.id);
      onSaved(`Rule removed. The built-in reader picks the ${name} again in emails from ${biller.name}.`);
    },
  });
  const busy = save.isPending || remove.isPending;

  const data = choices.data;
  const selected = data?.choices.find((choice) => choiceKey(choice) === chosen) ?? null;
  const failed = save.error ?? remove.error;

  return (
    <div role="group" aria-labelledby={headingId} className="mt-3 flex flex-col gap-3 rounded-md border border-accent bg-surface p-3">
      <div>
        <h3 id={headingId} ref={heading} tabIndex={-1} className="font-semibold outline-none">
          Which is the {name}?
        </h3>
        <p className="mt-1 text-sm text-muted">
          Choose the right value. OurHomeInbox remembers the words it comes after and uses them for every email from {biller.name}.
        </p>
      </div>

      {choices.isPending ? <LoadingState label="Looking through this email" /> : null}
      {choices.isError ? <ErrorState error={choices.error} onRetry={() => void choices.refetch()} /> : null}

      {data?.rule ? (
        <Notice tone="info">
          <p>Picked now by your rule: the value after "{data.rule.label}".</p>
          <Button variant="secondary" className="mt-2 px-3 py-1" busy={remove.isPending} disabled={busy} onClick={() => remove.mutate()}>
            Remove the rule
          </Button>
        </Notice>
      ) : null}

      {data && data.choices.length === 0 ? (
        <p className="text-muted">
          Nothing in this email looks like {KIND_OF_VALUE[FIELD_TYPES[field]]} with words before it, so there is nothing to choose here.
        </p>
      ) : null}

      {data && data.choices.length > 0 ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">Values in this email</legend>
          {data.choices.map((choice) => {
            const key = choiceKey(choice);
            return (
              <label
                key={key}
                className={`flex cursor-pointer items-start gap-3 rounded-md border bg-surface px-3 py-2 ${chosen === key ? "border-accent" : "border-line"}`}
              >
                <input
                  type="radio"
                  name={radioName}
                  value={key}
                  checked={chosen === key}
                  onChange={() => setChosen(key)}
                  disabled={busy}
                  className="mt-1 accent-accent"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{formatPicked(field, choice.value.value)}</span>
                    {choice.current ? (
                      <span className="rounded-full border border-line bg-surface-muted px-2 py-0.5 text-xs font-medium">Picked now</span>
                    ) : null}
                  </span>
                  <span className="block text-sm text-muted">
                    After "{choice.label}"{choice.from === "invoice" ? ", in the invoice" : ""}
                  </span>
                  <Where
                    pieces={choice.from === "invoice" ? invoicePieces : pieces}
                    spot={choice.value.spots[0]!}
                    inInvoice={choice.from === "invoice"}
                  />
                </span>
              </label>
            );
          })}
        </fieldset>
      ) : null}

      {selected && !selected.current && data ? <Effect choice={selected} field={field} biller={biller} otherEmails={data.otherEmails} /> : null}
      {failed ? (
        <Notice tone="error" live>
          {failed.message}
        </Notice>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          busy={save.isPending}
          disabled={!selected || selected.current || busy}
          onClick={() => selected && save.mutate(selected.label)}
        >
          Use this one
        </Button>
        <Button variant="secondary" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
