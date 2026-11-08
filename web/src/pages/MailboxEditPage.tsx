// Adding a mailbox (/settings/mailboxes/new), changing one
// (/settings/mailboxes/:id) or restoring a removed one with its mail
// (/settings/mailboxes/removed/:id), with "Test connection" to try the
// settings first (it lists the mailbox's folders to choose from) and remove
// on the change page. A mailbox reads one or more folders: each is typed and
// added with Enter or by leaving the box, and listed below it. Folders or
// labels to leave out are listed the same way, below those. A saved
// password is never shown; leaving the box empty keeps it, but only for the
// same server and login: a changed one needs it typed again. A removed
// mailbox's password was not kept.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, PlugZap, X } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import type { MailboxInfo, MailboxInput } from "../../../src/shared/api";
import { api } from "../api";
import { Button, buttonClasses, Card, ChoiceField, ErrorState, LoadingState, Notice, PageTitle, TextField } from "../components/ui";
import {
  addFolder,
  checkConnection,
  checkMailboxForm,
  emailCount,
  EMPTY_MAILBOX_FORM,
  formFromMailbox,
  formFromRemoved,
  PROVIDER_LABELS,
  sameServer,
  SECURITY_CHOICES,
  type FolderList,
  type MailboxForm,
  type MailboxFormErrors,
} from "../mailboxes";
import { refreshAfterMailboxChange, useMailboxes } from "../queries";
import { NotFoundPage } from "./NotFoundPage";

function BackLink() {
  return (
    <Link to="/settings" className="mb-4 inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline">
      <ArrowLeft aria-hidden className="size-4" />
      Back to settings
    </Link>
  );
}

/** The words of each folder list: the folders read, and the ones left out. */
const FOLDER_FIELDS = {
  folders: {
    label: "Folders",
    hint: "Type one, like Finance/Bills, and press Enter. Labels start with Labels/.",
    picker: "Folders in this mailbox",
    pick: "Add a folder...",
    listed: "Folders to read",
  },
  skipFolders: {
    label: "Leave out emails also in",
    hint: "Optional. A label your mail filter adds to emails you don't want, like Labels/Skip. Emails in it are not brought in.",
    picker: "Pick one to leave out",
    pick: "Leave out a folder...",
    listed: "Folders to leave out",
  },
} as const satisfies Record<FolderList, { label: string; hint: string; picker: string; pick: string; listed: string }>;

/**
 * A list of folders (the ones read, or the ones left out): one is typed, then
 * added with Enter or by leaving the box, and listed below it. Beside the
 * box, the mailbox's own folders to pick from, which "Test connection" loads
 * (null until it has run); ones already in either list cannot be picked.
 */
function FoldersField({
  list,
  folders,
  taken,
  draft,
  error,
  available,
  onDraft,
  onAdd,
  onPick,
  onRemove,
}: {
  list: FolderList;
  folders: string[];
  /** The folders in the other list. */
  taken: string[];
  draft: string;
  error: string | undefined;
  available: string[] | null;
  onDraft: (draft: string) => void;
  onAdd: () => void;
  onPick: (folder: string) => void;
  onRemove: (folder: string) => void;
}) {
  const id = useId();
  const pickerId = useId();
  const words = FOLDER_FIELDS[list];
  const hint = error ? undefined : words.hint;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const loaded = available !== null && available.length > 0;
  const pickerPrompt = available === null ? "Test connection to load folders" : loaded ? words.pick : "No folders found";
  return (
    <div className="flex flex-col gap-1">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor={id} className="text-sm font-medium">
            {words.label}
          </label>
          <input
            id={id}
            value={draft}
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="off"
            enterKeyHint="done"
            aria-invalid={error ? true : undefined}
            aria-describedby={[hintId, errorId].filter(Boolean).join(" ") || undefined}
            onChange={(e) => onDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter adds the folder instead of saving the form; not while an input method is still composing.
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                onAdd();
              }
            }}
            onBlur={onAdd}
            className={`w-full rounded-md border bg-surface px-3 py-2 text-base text-ink placeholder:text-muted ${error ? "border-danger" : "border-line"}`}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor={pickerId} className="text-sm font-medium">
            {words.picker}
          </label>
          <select
            id={pickerId}
            value=""
            disabled={!loaded}
            onChange={(e) => e.target.value && onPick(e.target.value)}
            className="w-full min-w-0 rounded-md border border-line bg-surface px-3 py-2 text-base text-ink disabled:cursor-not-allowed disabled:text-muted"
          >
            <option value="">{pickerPrompt}</option>
            {(available ?? []).map((name) => (
              <option key={name} value={name} disabled={folders.includes(name) || taken.includes(name)}>
                {name}
              </option>
            ))}
          </select>
        </div>
      </div>
      {hint ? (
        <p id={hintId} className="text-sm text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      {folders.length > 0 ? (
        <ul aria-label={words.listed} className="mt-1 flex min-w-0 flex-wrap gap-2">
          {folders.map((folder) => (
            <li key={folder} className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-md border border-line bg-surface-muted py-0.5 pl-3 pr-0.5 text-sm">
              <span className="min-w-0 font-mono wrap-anywhere">{folder}</span>
              <button
                type="button"
                onClick={() => onRemove(folder)}
                aria-label={`Remove ${folder}`}
                className="shrink-0 rounded p-1.5 text-muted hover:bg-surface hover:text-ink"
              >
                <X aria-hidden className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function MailboxFormCard({
  initial,
  saved,
  submitLabel,
  busy,
  error,
  onSubmit,
}: {
  initial: MailboxForm;
  /** The mailbox being changed, or null when adding one. */
  saved: MailboxInfo | null;
  submitLabel: string;
  busy: boolean;
  error: Error | null;
  onSubmit: (input: MailboxInput) => void;
}) {
  const [form, setForm] = useState<MailboxForm>(initial);
  const [errors, setErrors] = useState<MailboxFormErrors>({});
  const enabledHintId = useId();
  const passwordSaved = saved?.imap.passwordSet ?? false;
  // A saved password is only ever sent to the server it was saved for.
  const serverChanged = saved !== null && passwordSaved && !sameServer(form, saved);
  const test = useMutation({ mutationFn: api.testMailbox });

  const text = (key: "name" | "host" | "port" | "username" | "password") => ({
    value: form[key],
    onChange: (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value })),
    error: errors[key],
  });

  const draftOf = (list: FolderList) => (list === "folders" ? "folderDraft" : "skipDraft");

  /** Adds the folder typed in the list's box, or says why it cannot be. */
  function commitFolder(list: FolderList) {
    const added = addFolder(form, list);
    setForm(added.form);
    setErrors((e) => ({ ...e, [list]: added.error ?? undefined }));
  }

  /** Adds a folder chosen from the test's list, keeping whatever is typed in the box. */
  function pickFolder(list: FolderList, folder: string) {
    const draft = draftOf(list);
    const added = addFolder({ ...form, [draft]: folder }, list);
    if (!added.error) setForm({ ...added.form, [draft]: form[draft] });
    setErrors((e) => ({ ...e, [list]: added.error ?? undefined }));
  }

  const folderField = (list: FolderList) => {
    const draft = draftOf(list);
    return (
      <FoldersField
        list={list}
        folders={form[list]}
        taken={form[list === "folders" ? "skipFolders" : "folders"]}
        draft={form[draft]}
        error={errors[list]}
        available={test.data?.folders ?? null}
        onDraft={(text) => setForm((f) => ({ ...f, [draft]: text }))}
        onAdd={() => commitFolder(list)}
        onPick={(folder) => pickFolder(list, folder)}
        onRemove={(folder) => setForm((f) => ({ ...f, [list]: f[list].filter((name) => name !== folder) }))}
      />
    );
  };

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const checked = checkMailboxForm(form, saved);
    setErrors(checked.errors);
    if (checked.input) onSubmit(checked.input);
  }

  function tryIt() {
    const checked = checkConnection(form, saved);
    setErrors(checked.errors);
    if (checked.connection) test.mutate({ ...checked.connection, ...(saved ? { id: saved.id } : {}) });
  }

  const passwordHint = saved
    ? saved.imap.passwordProblem
      ? saved.imap.passwordProblem
      : serverChanged
        ? "The server or login changed, so enter the password again: a saved password is only sent to the server it was saved for."
        : passwordSaved
          ? "A password is saved. Leave this empty to keep it."
          : "No password is saved yet."
    : "For Proton Mail Bridge, the password its info command shows, not your Proton password.";

  return (
    <Card>
      <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <TextField label="Name" autoComplete="off" hint="As you want to see it, like Sam's Proton or Bills." required {...text("name")} />
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium">Kind</span>
          <span>{PROVIDER_LABELS[form.provider]}</span>
        </div>
        <TextField
          label="IMAP server"
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="off"
          hint="For the Bridge in Docker, its container's name, like protonmail-bridge. For the Bridge app on the computer running Docker, host.docker.internal."
          {...text("host")}
        />
        <TextField label="Port" inputMode="numeric" autoComplete="off" hint="The IMAP port the Bridge shows, like 1143." {...text("port")} />
        <ChoiceField
          label="Security"
          choices={SECURITY_CHOICES}
          value={form.security}
          onChange={(security) => setForm((f) => ({ ...f, security }))}
          error={errors.security}
        />
        <TextField label="Username" autoComplete="off" spellCheck={false} autoCapitalize="off" {...text("username")} />
        <TextField label="Password" type="password" autoComplete="new-password" hint={passwordHint} {...text("password")} />
        {folderField("folders")}
        {folderField("skipFolders")}
        {saved ? (
          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
              aria-describedby={enabledHintId}
              className="mt-1 size-4 accent-accent"
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium">Read this mailbox</span>
              <span id={enabledHintId} className="block text-sm text-muted">
                Turn this off to pause it. Its captured mail stays.
              </span>
            </span>
          </label>
        ) : null}

        <div className="flex flex-col gap-3 border-t border-line pt-4">
          <div>
            <Button variant="secondary" busy={test.isPending} onClick={tryIt}>
              <PlugZap aria-hidden className="size-4" />
              Test connection
            </Button>
            <p className="mt-1 text-sm text-muted">Signs in, loads this mailbox's folders to choose from and opens each one chosen, without changing anything. Nothing is saved.</p>
          </div>
          {test.isError ? (
            <Notice tone="error" live>
              {test.error.message}
            </Notice>
          ) : null}
          {test.data ? (
            <Notice tone={test.data.ok ? "info" : "warning"} live>
              {test.data.message}
            </Notice>
          ) : null}
        </div>

        {error ? (
          <Notice tone="error" live>
            {error.message}
          </Notice>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" busy={busy}>
            {submitLabel}
          </Button>
          <Link to="/settings" className={buttonClasses("secondary")}>
            Cancel
          </Link>
        </div>
      </form>
    </Card>
  );
}

export function NewMailboxPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const create = useMutation({
    mutationFn: api.createMailbox,
    onSuccess: () => {
      refreshAfterMailboxChange(queryClient);
      void navigate("/settings");
    },
  });
  return (
    <div>
      <BackLink />
      <PageTitle description="Where OurHomeInbox reads your bills from. Mail is only ever read: nothing is moved, deleted or marked read.">
        Add a mailbox
      </PageTitle>
      <MailboxFormCard
        initial={EMPTY_MAILBOX_FORM}
        saved={null}
        submitLabel="Add mailbox"
        busy={create.isPending}
        error={create.error}
        onSubmit={(input) => create.mutate(input)}
      />
    </div>
  );
}

function RemoveMailbox({ mailbox }: { mailbox: MailboxInfo }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation({
    mutationFn: () => api.deleteMailbox(mailbox.id),
    onSuccess: () => {
      refreshAfterMailboxChange(queryClient);
      void navigate("/settings");
    },
  });
  return (
    <Card>
      <h2 className="text-lg font-semibold">Remove this mailbox</h2>
      <p className="mt-1 text-muted">
        OurHomeInbox stops reading it and forgets its password. Its captured emails stay on disk but are no longer shown, until you
        restore it from Settings. To stop reading it for a while, pause it above instead.
      </p>
      {remove.isError ? (
        <Notice tone="error" live className="mt-3">
          {remove.error.message}
        </Notice>
      ) : null}
      {confirming ? (
        <div className="mt-3 flex flex-col gap-3">
          <p className="font-medium wrap-anywhere">Remove {mailbox.name}?</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="danger" busy={remove.isPending} onClick={() => remove.mutate()}>
              Yes, remove it
            </Button>
            <Button variant="secondary" disabled={remove.isPending} onClick={() => setConfirming(false)}>
              Keep it
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="secondary" className="mt-3" onClick={() => setConfirming(true)}>
          Remove mailbox
        </Button>
      )}
    </Card>
  );
}

function EditMailbox({ mailbox }: { mailbox: MailboxInfo }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const update = useMutation({
    mutationFn: (input: MailboxInput) => api.updateMailbox(mailbox.id, input),
    onSuccess: () => {
      refreshAfterMailboxChange(queryClient);
      void navigate("/settings");
    },
  });
  return (
    <div className="flex flex-col gap-5">
      <MailboxFormCard
        initial={formFromMailbox(mailbox)}
        saved={mailbox}
        submitLabel="Save changes"
        busy={update.isPending}
        error={update.error}
        onSubmit={(input) => update.mutate(input)}
      />
      <RemoveMailbox mailbox={mailbox} />
    </div>
  );
}

/** The mailbox id in the address, or null when it is not one. */
function useMailboxId(): number | null {
  const { id: idText = "" } = useParams();
  const id = /^[1-9]\d*$/.test(idText) ? Number(idText) : null;
  return id !== null && Number.isSafeInteger(id) ? id : null;
}

export function RestoreMailboxPage() {
  const id = useMailboxId();
  const mailboxes = useMailboxes();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const restore = useMutation({
    mutationFn: (input: MailboxInput) => api.restoreMailbox(id!, input),
    onSuccess: () => {
      refreshAfterMailboxChange(queryClient);
      void navigate("/settings");
    },
  });
  if (id === null) return <NotFoundPage />;
  const removed = mailboxes.data?.removed.find((m) => m.id === id);
  if (mailboxes.data && !removed) return <NotFoundPage />;
  return (
    <div>
      <BackLink />
      <PageTitle description="Brings this mailbox back as it was, with the emails it captured before. They are not captured again.">
        {removed ? <span className="wrap-anywhere">Restore {removed.name}</span> : "Restore a mailbox"}
      </PageTitle>
      {mailboxes.isPending ? <LoadingState label="Loading this mailbox" /> : null}
      {mailboxes.isError ? <ErrorState error={mailboxes.error} onRetry={() => void mailboxes.refetch()} /> : null}
      {removed ? (
        <div className="flex flex-col gap-5">
          <Notice tone="info">
            {emailCount(removed.emails)} come back when you restore it.{" "}
            {removed.imap
              ? "Its password was not kept: enter it again."
              : "It was removed before removed mailboxes were kept, so its server and login are not known: enter them and its password again."}
          </Notice>
          <MailboxFormCard
            initial={formFromRemoved(removed)}
            saved={null}
            submitLabel="Restore mailbox"
            busy={restore.isPending}
            error={restore.error}
            onSubmit={(input) => restore.mutate(input)}
          />
        </div>
      ) : null}
    </div>
  );
}

export function EditMailboxPage() {
  const id = useMailboxId();
  const mailboxes = useMailboxes();
  if (id === null) return <NotFoundPage />;
  const mailbox = mailboxes.data?.mailboxes.find((m) => m.id === id);
  if (mailboxes.data && !mailbox) return <NotFoundPage />;
  return (
    <div>
      <BackLink />
      <PageTitle>{mailbox ? <span className="wrap-anywhere">{mailbox.name}</span> : "Mailbox"}</PageTitle>
      {mailboxes.isPending ? <LoadingState label="Loading this mailbox" /> : null}
      {mailboxes.isError ? <ErrorState error={mailboxes.error} onRetry={() => void mailboxes.refetch()} /> : null}
      {/* Keyed on the saved version, so the form starts from what was loaded. */}
      {mailbox ? <EditMailbox key={mailbox.updatedAt} mailbox={mailbox} /> : null}
    </div>
  );
}
