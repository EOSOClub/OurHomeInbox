// Adding a biller (/billers/new) or changing one (/billers/:id), with delete
// on the change page. A new biller can be started from a captured email:
// ?name=...&sender=... fill the form in; on the change page ?addSender=...
// adds an email's sender to the list. Nothing is saved until Save. The change
// page also lists the biller's rules from Fix, each with Remove.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import type { Biller, BillerInput } from "../../../src/shared/api";
import type { FieldName } from "../../../src/shared/extraction";
import { api } from "../api";
import { checkBillerForm, EMPTY_BILLER_FORM, KIND_CHOICES, sendersWith, type BillerForm, type BillerFormErrors } from "../billers";
import {
  Button,
  buttonClasses,
  Card,
  ChoiceField,
  DetailRow,
  ErrorState,
  LoadingState,
  Notice,
  PageTitle,
  TextAreaField,
  TextField,
} from "../components/ui";
import { plural } from "../format";
import { FIELD_LABELS } from "../mail/picked";
import { queryKeys, refreshAfterBillerChange, refreshAfterRuleChange, useBiller, useBillerRules } from "../queries";
import { NotFoundPage } from "./NotFoundPage";

function BackLink() {
  return (
    <Link to="/billers" className="mb-4 inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline">
      <ArrowLeft aria-hidden className="size-4" />
      Back to billers
    </Link>
  );
}

function BillerFormCard({
  initial,
  submitLabel,
  busy,
  error,
  onSubmit,
}: {
  initial: BillerForm;
  submitLabel: string;
  busy: boolean;
  error: Error | null;
  onSubmit: (input: BillerInput) => void;
}) {
  const [form, setForm] = useState<BillerForm>(initial);
  const [errors, setErrors] = useState<BillerFormErrors>({});
  const invoiceHintId = useId();

  const text = (key: "name" | "senders" | "notes") => ({
    value: form[key],
    onChange: (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value })),
    error: errors[key],
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const checked = checkBillerForm(form);
    setErrors(checked.errors);
    if (checked.input) onSubmit(checked.input);
  }

  return (
    <Card>
      <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <TextField label="Name" autoComplete="off" hint="As you want to see it, like City Water or Netflix." required {...text("name")} />
        <ChoiceField
          label="Kind"
          choices={KIND_CHOICES}
          value={form.kind}
          onChange={(kind) => setForm((f) => ({ ...f, kind }))}
          error={errors.kind}
        />
        <TextAreaField
          label="Emails come from"
          rows={4}
          spellCheck={false}
          autoCapitalize="off"
          hint="One per line. A full address like billing@citywater.com, or just the part after the @ like citywater.com to cover every address there."
          {...text("senders")}
        />
        <TextAreaField label="Notes (optional)" rows={3} hint="Anything that helps, like which account this is." {...text("notes")} />
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={form.fetchInvoices}
            onChange={(e) => setForm((f) => ({ ...f, fetchInvoices: e.target.checked }))}
            aria-describedby={invoiceHintId}
            className="mt-1 size-4 accent-accent"
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium">Get the invoice from its link</span>
            <span id={invoiceHintId} className="block text-sm text-muted">
              When an email from this biller has a link like "View Invoice" and Proton confirmed who sent it, OurHomeInbox opens the
              link once and keeps the invoice with the email. Turn this off if the link asks for your password.
            </span>
          </span>
        </label>
        {error ? (
          <Notice tone="error" live>
            {error.message}
          </Notice>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" busy={busy}>
            {submitLabel}
          </Button>
          <Link to="/billers" className={buttonClasses("secondary")}>
            Cancel
          </Link>
        </div>
      </form>
    </Card>
  );
}

export function NewBillerPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const sender = params.get("sender")?.trim() ?? "";
  const initial: BillerForm = { ...EMPTY_BILLER_FORM, name: params.get("name")?.trim() ?? "", senders: sender };
  const create = useMutation({
    mutationFn: api.createBiller,
    onSuccess: (biller) => {
      queryClient.setQueryData(queryKeys.biller(biller.id), biller);
      refreshAfterBillerChange(queryClient);
      void navigate("/billers");
    },
  });

  return (
    <div>
      <BackLink />
      <PageTitle description={sender ? "Filled in from the email. Check it, then save." : undefined}>Add a biller</PageTitle>
      <BillerFormCard initial={initial} submitLabel="Add biller" busy={create.isPending} error={create.error} onSubmit={(input) => create.mutate(input)} />
    </div>
  );
}

function DeleteBiller({ biller }: { biller: Biller }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation({
    mutationFn: () => api.deleteBiller(biller.id),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: queryKeys.biller(biller.id), exact: true });
      refreshAfterBillerChange(queryClient);
      void navigate("/billers");
    },
  });

  return (
    <Card>
      <h2 className="text-lg font-semibold">Delete this biller</h2>
      <p className="mt-1 text-muted">Deleting a biller does not delete or change any email.</p>
      {remove.isError ? (
        <Notice tone="error" live className="mt-3">
          {remove.error.message}
        </Notice>
      ) : null}
      {confirming ? (
        <div className="mt-3 flex flex-col gap-3">
          <p className="font-medium wrap-anywhere">Delete {biller.name}? This cannot be undone.</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="danger" busy={remove.isPending} onClick={() => remove.mutate()}>
              Yes, delete it
            </Button>
            <Button variant="secondary" disabled={remove.isPending} onClick={() => setConfirming(false)}>
              Keep it
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="secondary" className="mt-3" onClick={() => setConfirming(true)}>
          Delete biller
        </Button>
      )}
    </Card>
  );
}

/** The rules saved with Fix on this biller's emails, each with how often it is used and a Remove button. */
function BillerRules({ biller }: { biller: Biller }) {
  const queryClient = useQueryClient();
  const rules = useBillerRules(biller.id);
  const remove = useMutation({
    mutationFn: (field: FieldName) => api.deleteBillerRule(biller.id, field),
    onSuccess: () => refreshAfterRuleChange(queryClient, biller.id),
  });

  return (
    <Card>
      <h2 className="text-lg font-semibold">Where values are found</h2>
      <p className="mt-1 text-muted">
        When you use Fix on an email from <span className="wrap-anywhere">{biller.name}</span>, OurHomeInbox remembers the words the value
        comes after. Those rules are listed here and used for every email from this biller.
      </p>
      {rules.isPending ? <LoadingState label="Loading the rules" /> : null}
      {rules.isError ? <ErrorState error={rules.error} onRetry={() => void rules.refetch()} /> : null}
      {remove.isError ? (
        <Notice tone="error" live className="mt-3">
          {remove.error.message}
        </Notice>
      ) : null}
      {rules.data && rules.data.rules.length === 0 ? (
        <p className="mt-3 text-muted">No rules yet. The built-in reader picks out the values on its own. To add one, open an email from this biller and use Fix.</p>
      ) : null}
      {rules.data && rules.data.rules.length > 0 ? (
        <dl className="mt-3 divide-y divide-line">
          {rules.data.rules.map((rule) => (
            <DetailRow key={rule.field} label={FIELD_LABELS[rule.field]}>
              <span className="block font-medium wrap-anywhere">The value after "{rule.label}"</span>
              <span className="block text-sm text-muted">
                Used in {rule.usedOn} of {plural(rules.data.emails, "email", "emails")}
              </span>
              <Button
                variant="secondary"
                className="mt-2 px-3 py-1"
                aria-label={`Remove the rule for the ${FIELD_LABELS[rule.field].toLowerCase()}`}
                busy={remove.isPending && remove.variables === rule.field}
                disabled={remove.isPending}
                onClick={() => remove.mutate(rule.field)}
              >
                Remove
              </Button>
            </DetailRow>
          ))}
        </dl>
      ) : null}
    </Card>
  );
}

function EditBiller({ biller, addSender }: { biller: Biller; addSender: string | null }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const update = useMutation({
    mutationFn: (input: BillerInput) => api.updateBiller(biller.id, input),
    onSuccess: (saved) => {
      queryClient.setQueryData(queryKeys.biller(saved.id), saved);
      refreshAfterBillerChange(queryClient);
      void navigate("/billers");
    },
  });
  // Computed once, so the form keeps what was typed while it is open.
  const [{ text, added }] = useState(() => sendersWith(biller.senders, addSender));
  const initial: BillerForm = { name: biller.name, kind: biller.kind, senders: text, notes: biller.notes, fetchInvoices: biller.fetchInvoices };

  return (
    <div className="flex flex-col gap-5">
      {added ? (
        <Notice tone="info">
          <span className="wrap-anywhere">{added}</span> from the email is added to the list below. Save to keep it.
        </Notice>
      ) : null}
      <BillerFormCard initial={initial} submitLabel="Save changes" busy={update.isPending} error={update.error} onSubmit={(input) => update.mutate(input)} />
      <BillerRules biller={biller} />
      <DeleteBiller biller={biller} />
    </div>
  );
}

export function EditBillerPage() {
  const { id: idText = "" } = useParams();
  const id = /^[1-9]\d*$/.test(idText) ? Number(idText) : null;
  if (id === null || !Number.isSafeInteger(id)) return <NotFoundPage />;
  return <EditBillerLoaded id={id} />;
}

function EditBillerLoaded({ id }: { id: number }) {
  const biller = useBiller(id);
  const [params] = useSearchParams();
  const addSender = params.get("addSender");
  return (
    <div>
      <BackLink />
      <PageTitle>{biller.data ? <span className="wrap-anywhere">{biller.data.name}</span> : "Biller"}</PageTitle>
      {biller.isPending ? <LoadingState label="Loading this biller" /> : null}
      {biller.isError ? <ErrorState error={biller.error} onRetry={() => void biller.refetch()} /> : null}
      {/* Keyed on the saved version, so the form starts from what was loaded. */}
      {biller.data ? <EditBiller key={biller.data.updatedAt} biller={biller.data} addSender={addSender} /> : null}
    </div>
  );
}
