// Fix: choosing the right value for one field of an email. Lists each value
// of the right kind in the email with the words before it; choosing one saves
// a rule on the biller ("the amount is the value after Current Charges"),
// used for every email from that biller, past and future. When nothing else
// gives the field in this email, the rule can instead be used only in emails
// where nothing else gives it (owner, 2026-11-08), so a reminder's "Past Due
// Balance" does not change the bills; each way says what it would change.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import type { BillerMatch } from "../../../src/shared/api";
import { FIELD_TYPES, type FieldChoice, type FieldName, type RuleWhen } from "../../../src/shared/extraction";
import { api } from "../api";
import { Button, ErrorState, LoadingState, Notice } from "../components/ui";
import { plural } from "../format";
import { refreshAfterRuleChange, useChoices } from "../queries";
import { Where } from "./EmailWords";
import { FIELD_LABELS, formatPicked } from "./picked";

const KIND_OF_VALUE = { money: "an amount of money", date: "a date", number: "a number" } as const;

const choiceKey = (choice: FieldChoice) => `${choice.from}|${choice.label.toLowerCase()}|${choice.value.value}`;

/** How many other emails a rule changes, in plain words. */
function reachText(changes: number, field: FieldName, biller: BillerMatch, otherEmails: number): string {
  if (otherEmails === 0) return `There are no other emails from ${biller.name} yet. New ones will use it too.`;
  if (changes === 0) return `It changes nothing in the other ${plural(otherEmails, "email", "emails")} from ${biller.name}.`;
  return `It changes the ${FIELD_LABELS[field].toLowerCase()} in ${plural(changes, "other email", "other emails")} from ${biller.name}.`;
}

/** Where a rule is used, as the choice in Fix says it. */
export function whenLabel(when: RuleWhen, field: FieldName, biller: BillerMatch): string {
  const name = FIELD_LABELS[field].toLowerCase();
  return when === "missing" ? `Only in emails where no ${name} is found otherwise` : `In every email from ${biller.name}`;
}

/** What saving `choice` would do, in plain words; with both ways to use it when this email has nothing else for the field. */
function Effect({
  choice,
  field,
  biller,
  otherEmails,
  when,
  onWhen,
  disabled,
}: {
  choice: FieldChoice;
  field: FieldName;
  biller: BillerMatch;
  otherEmails: number;
  when: RuleWhen;
  onWhen: (when: RuleWhen) => void;
  disabled: boolean;
}) {
  const radioName = useId();
  const ways: Array<{ when: RuleWhen; changes: number }> =
    choice.changesWhenMissing === null
      ? []
      : [
          { when: "missing", changes: choice.changesWhenMissing },
          { when: "always", changes: choice.changes },
        ];
  return (
    <div className="flex flex-col gap-2">
      {ways.length > 0 ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">Use it</legend>
          {ways.map((way) => (
            <label
              key={way.when}
              className={`flex cursor-pointer items-start gap-3 rounded-md border bg-surface px-3 py-2 ${when === way.when ? "border-accent" : "border-line"}`}
            >
              <input
                type="radio"
                name={radioName}
                value={way.when}
                checked={when === way.when}
                onChange={() => onWhen(way.when)}
                disabled={disabled}
                className="mt-1 accent-accent"
              />
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{whenLabel(way.when, field, biller)}</span>
                <span className="block text-sm text-muted">{reachText(way.changes, field, biller, otherEmails)}</span>
              </span>
            </label>
          ))}
        </fieldset>
      ) : (
        <Notice tone="info" live>
          {reachText(choice.changes, field, biller, otherEmails)}
        </Notice>
      )}
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
  // Only where nothing else gives the field, when that is offered: it changes the fewest other emails.
  const [when, setWhen] = useState<RuleWhen>("missing");
  const name = FIELD_LABELS[field].toLowerCase();

  // Keyboard and screen reader users land on the question.
  useEffect(() => heading.current?.focus(), []);

  const save = useMutation({
    mutationFn: (rule: { label: string; when: RuleWhen }) => api.saveBillerRule(biller.id, field, rule),
    onSuccess: (_, { label, when }) => {
      refreshAfterRuleChange(queryClient, biller.id);
      onSaved(
        when === "missing"
          ? `Saved. In emails from ${biller.name} where no ${name} is found otherwise, the ${name} is now the value after "${label}".`
          : `Saved. The ${name} in every email from ${biller.name} is now the value after "${label}".`,
      );
    },
  });
  const remove = useMutation({
    mutationFn: (label: string) => api.deleteBillerRule(biller.id, field, label),
    onSuccess: (_, label) => {
      refreshAfterRuleChange(queryClient, biller.id);
      const left = (choices.data?.rules.length ?? 1) - 1;
      onSaved(
        left > 0
          ? `Rule removed. Emails from ${biller.name} no longer look for the ${name} after "${label}".`
          : `Rule removed. The built-in reader picks the ${name} again in emails from ${biller.name}.`,
      );
    },
  });
  const busy = save.isPending || remove.isPending;

  const data = choices.data;
  const selected = data?.choices.find((choice) => choiceKey(choice) === chosen) ?? null;
  // The way it would be saved: only where nothing else gives the field when that is offered and chosen.
  const useWhen: RuleWhen = selected?.changesWhenMissing !== null && selected?.changesWhenMissing !== undefined ? when : "always";
  // Picked now, and not by a rule on these words that is used the other way: nothing to save.
  const fieldRules = data?.rules ?? [];
  const sameWords = selected ? fieldRules.find((rule) => rule.label.toLowerCase() === selected.label.toLowerCase()) : undefined;
  const switchesWay = sameWords !== undefined && (sameWords.when ?? "always") !== useWhen;
  const unchanged = selected === null || (selected.current && !switchesWay);
  const failed = save.error ?? remove.error;

  return (
    <div role="group" aria-labelledby={headingId} className="mt-3 flex flex-col gap-3 rounded-md border border-accent bg-surface p-3">
      <div>
        <h3 id={headingId} ref={heading} tabIndex={-1} className="font-semibold outline-none">
          Which is the {name}?
        </h3>
        <p className="mt-1 text-sm text-muted">
          Choose the right value. OurHomeInbox remembers the words it comes after and uses them for other emails from {biller.name} too.
        </p>
      </div>

      {choices.isPending ? <LoadingState label="Looking through this email" /> : null}
      {choices.isError ? <ErrorState error={choices.error} onRetry={() => void choices.refetch()} /> : null}

      {fieldRules.length > 0 ? (
        <Notice tone="info">
          <p>{fieldRules.length === 1 ? "Your rule" : "Your rules"} for the {name} in emails from {biller.name}:</p>
          <ul className="mt-2 flex flex-col gap-2">
            {fieldRules.map((rule) => (
              <li key={rule.label} className="min-w-0">
                <span className="block wrap-anywhere">
                  The value after "{rule.label}"{rule.when === "missing" ? `, only in emails where no ${name} is found otherwise` : ""}.
                </span>
                <Button
                  variant="secondary"
                  className="mt-1 px-3 py-1"
                  aria-label={fieldRules.length === 1 ? "Remove the rule" : `Remove the rule on "${rule.label}"`}
                  busy={remove.isPending && remove.variables === rule.label}
                  disabled={busy}
                  onClick={() => remove.mutate(rule.label)}
                >
                  Remove the rule
                </Button>
              </li>
            ))}
          </ul>
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

      {selected && !unchanged && data ? (
        <Effect choice={selected} field={field} biller={biller} otherEmails={data.otherEmails} when={useWhen} onWhen={setWhen} disabled={busy} />
      ) : null}
      {failed ? (
        <Notice tone="error" live>
          {failed.message}
        </Notice>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          busy={save.isPending}
          disabled={unchanged || busy}
          onClick={() => selected && save.mutate({ label: selected.label, when: useWhen })}
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
