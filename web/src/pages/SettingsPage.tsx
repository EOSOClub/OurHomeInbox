// The settings in use, read-only for now. Never shows or asks for a password:
// only whether the password's line is present in .env.

import { CircleCheck, TriangleAlert } from "lucide-react";
import type { SettingsMailbox } from "../../../src/shared/api";
import { Card, DetailRow, ErrorState, LoadingState, Notice, PageTitle } from "../components/ui";
import { useSettings } from "../queries";

const PROVIDERS: Record<string, string> = { "proton-bridge": "Proton Mail Bridge" };

const SECURITY: Record<string, string> = {
  none: "None (no encryption; only for a server on the same computer or Docker network)",
  starttls: "STARTTLS (switches to encryption after connecting)",
  tls: "TLS (encrypted from the start, also called SSL/TLS)",
};

function PasswordStatus({ imap }: { imap: SettingsMailbox["imap"] }) {
  if (imap.passwordSet) {
    return (
      <span className="inline-flex items-start gap-1.5">
        <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-accent" />
        <span>
          Set in .env as <code className="font-mono text-sm">{imap.passwordEnv}</code>
        </span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-start gap-1.5 font-medium text-danger">
      <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span>
        Missing: add <code className="font-mono text-sm">{imap.passwordEnv}</code> to .env
      </span>
    </span>
  );
}

function MailboxCard({ mailbox }: { mailbox: SettingsMailbox }) {
  const { imap } = mailbox;
  return (
    <Card>
      <h3 className="text-lg font-semibold wrap-anywhere">{mailbox.name}</h3>
      <dl className="mt-2 divide-y divide-line">
        <DetailRow label="Provider">{PROVIDERS[mailbox.provider] ?? mailbox.provider}</DetailRow>
        <DetailRow label="Folder">
          <span className="font-mono text-sm">{mailbox.folder}</span>
        </DetailRow>
        <DetailRow label="IMAP server">{imap.host}</DetailRow>
        <DetailRow label="Port">{imap.port}</DetailRow>
        <DetailRow label="Security">{SECURITY[imap.security.toLowerCase()] ?? imap.security}</DetailRow>
        <DetailRow label="Username">{imap.username}</DetailRow>
        <DetailRow label="Password">
          <PasswordStatus imap={imap} />
        </DetailRow>
      </dl>
    </Card>
  );
}

export function SettingsPage() {
  const settings = useSettings();
  return (
    <div>
      <PageTitle>Settings</PageTitle>
      <Notice tone="info" className="mb-5">
        Settings are read-only here for now. Change config.yml and .env, or run docker/deploy.sh -s, then restart
        OurHomeInbox.
      </Notice>
      {settings.isPending ? <LoadingState label="Loading settings" /> : null}
      {settings.isError ? <ErrorState error={settings.error} onRetry={() => void settings.refetch()} /> : null}
      {settings.data ? (
        <div className="flex flex-col gap-5">
          <Card>
            <h2 className="text-lg font-semibold">General</h2>
            <dl className="mt-2 divide-y divide-line">
              <DetailRow label="Settings file">
                <span className="font-mono text-sm break-all">{settings.data.configPath}</span>
              </DetailRow>
              <DetailRow label="Log level">{settings.data.logLevel}</DetailRow>
              <DetailRow label="Web port">{settings.data.web.port}</DetailRow>
              <DetailRow label="Checks mail">
                {settings.data.capture.everyMinutes === 1 ? "Every minute" : `Every ${settings.data.capture.everyMinutes} minutes`}
              </DetailRow>
            </dl>
          </Card>
          <section>
            <h2 className="mb-3 text-lg font-semibold">Mailboxes</h2>
            {settings.data.mailboxes.length === 0 ? (
              <p className="text-muted">No mailboxes are set up in config.yml yet.</p>
            ) : (
              <div className="grid gap-4 md:grid-cols-2">
                {settings.data.mailboxes.map((mailbox) => (
                  <MailboxCard key={mailbox.slug} mailbox={mailbox} />
                ))}
              </div>
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}
