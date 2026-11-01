// Settings: the household's mailboxes (with how each last read went,
// "Check mail now", and removed ones to restore), your own password, the
// household's users (see users/UsersCard.tsx), and the install's settings
// from config.yml (how often mail is read and the log level, changed or
// reloaded without a restart). Everyone signed in can change all of it; the
// read-only views stay for when `canEdit` is false. A password is never shown.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, Plus, RotateCw, TriangleAlert } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import type { MailboxInfo, RemovedMailbox, SessionUser, SettingsResponse } from "../../../src/shared/api";
import { MIN_PASSWORD_LENGTH } from "../../../src/shared/api";
import { MAX_CAPTURE_MINUTES, MIN_CAPTURE_MINUTES, type LogLevel } from "../../../src/shared/settings";
import { api } from "../api";
import { CheckMailNow, useRefreshWhenReadFinishes } from "../components/CheckMail";
import { Button, buttonClasses, Card, ChoiceField, DetailRow, ErrorState, LoadingState, Notice, PageTitle, TextField } from "../components/ui";
import { checkingLine, emailCount, lastCheckLine, LOG_LEVEL_CHOICES, PROVIDER_LABELS, SECURITY_CHOICES } from "../mailboxes";
import { queryKeys, useMailboxes, useSession, useSettings } from "../queries";
import { UsersCard } from "../users/UsersCard";

function PasswordState({ mailbox }: { mailbox: MailboxInfo }) {
  if (mailbox.imap.passwordSet) {
    return (
      <span className="inline-flex items-start gap-1.5">
        <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-accent" />
        Saved
      </span>
    );
  }
  return (
    <span className="inline-flex items-start gap-1.5 font-medium text-danger">
      <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span>{mailbox.imap.passwordProblem ?? "Not saved yet: edit the mailbox to add it."}</span>
    </span>
  );
}

function MailboxRow({ mailbox, canEdit }: { mailbox: MailboxInfo; canEdit: boolean }) {
  const problem = mailbox.enabled && mailbox.lastCheck !== null && !mailbox.lastCheck.ok;
  const security = SECURITY_CHOICES.find((c) => c.value === mailbox.imap.security)?.label ?? mailbox.imap.security;
  return (
    <li className="py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold wrap-anywhere">{mailbox.name}</h3>
        {canEdit ? (
          <Link to={`/settings/mailboxes/${mailbox.id}`} className={buttonClasses("secondary", "px-3 py-1")}>
            Edit <span className="sr-only">{mailbox.name}</span>
          </Link>
        ) : null}
      </div>
      <p className={`mt-1 text-sm ${problem ? "font-medium text-warn" : "text-muted"}`}>{lastCheckLine(mailbox)}</p>
      <dl className="mt-2 divide-y divide-line">
        <DetailRow label="Reads">
          <span className="font-mono text-sm">{mailbox.folder}</span>
        </DetailRow>
        <DetailRow label="Server">
          <span className="wrap-anywhere">
            {PROVIDER_LABELS[mailbox.provider]}: {mailbox.imap.username} at {mailbox.imap.host}:{mailbox.imap.port} ({security})
          </span>
        </DetailRow>
        <DetailRow label="Password">
          <PasswordState mailbox={mailbox} />
        </DetailRow>
      </dl>
    </li>
  );
}

function MailboxesCard() {
  const mailboxes = useMailboxes();
  // When a read finishes, the mail list and each mailbox's result are fresh.
  useRefreshWhenReadFinishes(mailboxes.data?.checking.lastFinishedAt);
  const data = mailboxes.data;
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Mailboxes</h2>
        {data?.canEdit ? (
          <Link to="/settings/mailboxes/new" className={buttonClasses("secondary", "px-3 py-1.5")}>
            <Plus aria-hidden className="size-4" />
            Add a mailbox
          </Link>
        ) : null}
      </div>
      {mailboxes.isPending ? <LoadingState label="Loading mailboxes" /> : null}
      {mailboxes.isError ? <ErrorState error={mailboxes.error} onRetry={() => void mailboxes.refetch()} /> : null}
      {data ? (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="text-sm text-muted" role="status">
              {checkingLine(data.checking)}
            </p>
            <CheckMailNow checking={data.checking} disabled={data.mailboxes.length === 0} />
          </div>
          {data.mailboxes.length === 0 ? (
            <p className="mt-4 text-muted">
              No mailboxes yet.
              {data.canEdit
                ? data.removed.length > 0
                  ? " Add the one your bills arrive in, or restore a removed one below."
                  : " Add the one your bills arrive in."
                : " Ask an admin to add one."}
            </p>
          ) : (
            <ul className="mt-4 divide-y divide-line border-t border-line pt-4">
              {data.mailboxes.map((mailbox) => (
                <MailboxRow key={mailbox.id} mailbox={mailbox} canEdit={data.canEdit} />
              ))}
            </ul>
          )}
          {data.removed.length > 0 ? <RemovedMailboxes removed={data.removed} canEdit={data.canEdit} /> : null}
        </>
      ) : null}
    </Card>
  );
}

/** Removed mailboxes, kept so they can come back with their mail. */
function RemovedMailboxes({ removed, canEdit }: { removed: RemovedMailbox[]; canEdit: boolean }) {
  return (
    <section className="mt-5 border-t border-line pt-4" aria-labelledby="removed-mailboxes">
      <h3 id="removed-mailboxes" className="font-semibold">
        Removed mailboxes
      </h3>
      <p className="mt-1 text-sm text-muted">Not read, and their emails are not shown. Restoring one brings its emails back.</p>
      <ul className="mt-3 divide-y divide-line">
        {removed.map((mailbox) => (
          <li key={mailbox.id} className="flex flex-wrap items-center justify-between gap-2 py-3 first:pt-0 last:pb-0">
            <div className="min-w-0">
              <p className="font-medium wrap-anywhere">{mailbox.name}</p>
              <p className="text-sm text-muted wrap-anywhere">
                {emailCount(mailbox.emails)} kept{mailbox.folder ? <>, from <span className="font-mono">{mailbox.folder}</span></> : null}
              </p>
            </div>
            {canEdit ? (
              <Link to={`/settings/mailboxes/removed/${mailbox.id}`} className={buttonClasses("secondary", "px-3 py-1")}>
                Restore <span className="sr-only">{mailbox.name}</span>
              </Link>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ChangePassword() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [errors, setErrors] = useState<{ current?: string; next?: string; repeat?: string }>({});
  const change = useMutation({
    mutationFn: api.changePassword,
    onSuccess: () => {
      setCurrent("");
      setNext("");
      setRepeat("");
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const found: typeof errors = {};
    if (!current) found.current = "Enter your current password.";
    if (next.length < MIN_PASSWORD_LENGTH) found.next = `Choose a new password of at least ${MIN_PASSWORD_LENGTH} characters.`;
    else if (next === current) found.next = "Choose a new password that is different from your current one.";
    if (repeat !== next) found.repeat = "The two new passwords are not the same.";
    setErrors(found);
    if (Object.keys(found).length === 0) change.mutate({ currentPassword: current, newPassword: next });
  }

  return (
    <form className="mt-4 flex flex-col gap-4 border-t border-line pt-4" onSubmit={submit} noValidate>
      <h3 className="font-semibold">Change your password</h3>
      <TextField
        label="Current password"
        type="password"
        autoComplete="current-password"
        value={current}
        onChange={(e) => setCurrent(e.target.value)}
        error={errors.current}
      />
      <TextField
        label="New password"
        type="password"
        autoComplete="new-password"
        hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
        value={next}
        onChange={(e) => setNext(e.target.value)}
        error={errors.next}
      />
      <TextField
        label="New password again"
        type="password"
        autoComplete="new-password"
        value={repeat}
        onChange={(e) => setRepeat(e.target.value)}
        error={errors.repeat}
      />
      {change.isError ? (
        <Notice tone="error" live>
          {change.error.message}
        </Notice>
      ) : null}
      {change.isSuccess ? (
        <Notice tone="info" live>
          Password changed. Anywhere else you were signed in has been signed out.
        </Notice>
      ) : null}
      <div>
        <Button type="submit" variant="primary" busy={change.isPending}>
          Change password
        </Button>
      </div>
    </form>
  );
}

function AccountCard({ user }: { user: SessionUser }) {
  return (
    <Card>
      <h2 className="text-lg font-semibold">Your account</h2>
      <dl className="mt-2 divide-y divide-line">
        <DetailRow label="Name">{user.name}</DetailRow>
        <DetailRow label="Email">{user.email}</DetailRow>
        <DetailRow label="Household">{user.household.name}</DetailRow>
      </dl>
      <ChangePassword />
    </Card>
  );
}

type SaveSettings = ReturnType<typeof useSaveSettings>;

/**
 * Saving and reloading the install's settings. Kept above the form, which
 * starts again from the saved values after each, so their results stay shown.
 */
function useSaveSettings() {
  const queryClient = useQueryClient();
  const done = (fresh: SettingsResponse) => {
    queryClient.setQueryData(queryKeys.settings, fresh);
    void queryClient.invalidateQueries({ queryKey: queryKeys.mailboxes });
  };
  const save = useMutation({ mutationFn: api.updateSettings, onSuccess: done });
  const reload = useMutation({ mutationFn: api.reloadSettings, onSuccess: done });
  return { save, reload };
}

function InstallForm({ settings, actions }: { settings: SettingsResponse; actions: SaveSettings }) {
  const { save, reload } = actions;
  const [minutes, setMinutes] = useState(String(settings.captureEveryMinutes));
  const [level, setLevel] = useState<LogLevel>(settings.logLevel);
  const [minutesError, setMinutesError] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = Number(minutes.trim());
    if (!/^\d+$/.test(minutes.trim()) || value < MIN_CAPTURE_MINUTES || value > MAX_CAPTURE_MINUTES) {
      setMinutesError(`Enter a whole number of minutes from ${MIN_CAPTURE_MINUTES} to ${MAX_CAPTURE_MINUTES} (once a day).`);
      return;
    }
    setMinutesError(null);
    reload.reset();
    save.mutate({ captureEveryMinutes: value, logLevel: level });
  }

  const problem = save.error ?? reload.error;
  return (
    <form className="mt-4 flex flex-col gap-5" onSubmit={submit} noValidate>
      <TextField
        label="Read mail every (minutes)"
        inputMode="numeric"
        value={minutes}
        onChange={(e) => setMinutes(e.target.value)}
        error={minutesError}
        hint="Takes effect at once, counted from the end of the last read."
      />
      <ChoiceField label="Log detail" choices={LOG_LEVEL_CHOICES} value={level} onChange={setLevel} />
      {problem ? (
        <Notice tone="error" live>
          {problem.message}
        </Notice>
      ) : null}
      {save.isSuccess && !problem ? (
        <Notice tone="info" live>
          Saved to config.yml and in use now.
        </Notice>
      ) : null}
      {reload.isSuccess && !problem ? (
        <Notice tone="info" live>
          config.yml read again and in use now.
        </Notice>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" busy={save.isPending}>
          Save
        </Button>
        <Button
          variant="secondary"
          busy={reload.isPending}
          onClick={() => {
            save.reset();
            reload.mutate();
          }}
        >
          <RotateCw aria-hidden className="size-4" />
          Read config.yml again
        </Button>
      </div>
      <p className="-mt-3 text-sm text-muted">After editing config.yml by hand. A file with a mistake is refused, and the settings in use stay.</p>
    </form>
  );
}

function InstallCard() {
  const settings = useSettings();
  const actions = useSaveSettings();
  const data = settings.data;
  return (
    <Card>
      <h2 className="text-lg font-semibold">This install</h2>
      <p className="mt-1 text-muted">Settings for the whole of OurHomeInbox, kept in config.yml.</p>
      {settings.isPending ? <LoadingState label="Loading settings" /> : null}
      {settings.isError ? <ErrorState error={settings.error} onRetry={() => void settings.refetch()} /> : null}
      {data ? (
        <>
          {data.needsRestart.map((line) => (
            <Notice key={line} tone="warning" className="mt-3">
              {line}
            </Notice>
          ))}
          {data.ignoredMailboxes > 0 ? (
            <Notice tone="info" className="mt-3">
              config.yml still lists {data.ignoredMailboxes === 1 ? "a mailbox" : `${data.ignoredMailboxes} mailboxes`}. They were copied in
              when this version first started and are not read from there any more: change mailboxes above. You can remove them from config.yml.
            </Notice>
          ) : null}
          {data.canEdit ? (
            <InstallForm key={`${data.captureEveryMinutes}-${data.logLevel}`} settings={data} actions={actions} />
          ) : (
            <dl className="mt-2 divide-y divide-line">
              <DetailRow label="Reads mail">
                {data.captureEveryMinutes === 1 ? "Every minute" : `Every ${data.captureEveryMinutes} minutes`}
              </DetailRow>
              <DetailRow label="Log detail">{LOG_LEVEL_CHOICES.find((c) => c.value === data.logLevel)?.label ?? data.logLevel}</DetailRow>
            </dl>
          )}
          <dl className="mt-5 divide-y divide-line border-t border-line pt-3">
            <DetailRow label="Settings file">
              <span className="font-mono text-sm break-all">{data.configPath}</span>
            </DetailRow>
            <DetailRow label="Web port">
              {data.web.port}
              <span className="block text-sm text-muted">Changed in config.yml; takes effect when docker/deploy.sh runs.</span>
            </DetailRow>
            {data.docker ? (
              <DetailRow label="Docker">
                <span className="wrap-anywhere">
                  {[
                    data.docker.network ? `network ${data.docker.network}` : null,
                    data.docker.port ? `port ${data.docker.port}` : null,
                    data.docker.bind ? `open to ${data.docker.bind === "127.0.0.1" ? "this computer only" : data.docker.bind}` : null,
                  ]
                    .filter(Boolean)
                    .join(", ") || "Defaults"}
                </span>
                <span className="block text-sm text-muted">Used by docker/deploy.sh.</span>
              </DetailRow>
            ) : null}
            <DetailRow label="Saved passwords">
              {data.secretKey === "env"
                ? "Encrypted with the key in .env."
                : "Encrypted with the key in data/secret.key, next to the database. Running docker/deploy.sh moves the key into .env, so a copy of the data folder alone cannot open them."}
            </DetailRow>
          </dl>
        </>
      ) : null}
    </Card>
  );
}

export function SettingsPage() {
  const session = useSession();
  const user = session.data?.user;
  return (
    <div>
      <PageTitle>Settings</PageTitle>
      <div className="flex flex-col gap-5">
        <MailboxesCard />
        {user ? <AccountCard user={user} /> : null}
        <UsersCard />
        <InstallCard />
      </div>
    </div>
  );
}
