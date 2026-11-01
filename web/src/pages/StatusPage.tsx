// Status: whether OurHomeInbox is working. What needs someone first, then
// reading mail, each mailbox, the household's emails (each count with a link
// to the list narrowed to them), what the invoice links gave, and (for
// admins) the recent warnings and errors.

import { CircleCheck, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import type { MailboxInfo, StatusResponse } from "../../../src/shared/api";
import { INVOICE_OUTCOMES } from "../../../src/shared/invoice";
import { capturePagePath } from "../api";
import { CheckMailNow, useRefreshWhenReadFinishes } from "../components/CheckMail";
import { buttonClasses, Card, DetailRow, ErrorState, LoadingState, Notice, PageTitle } from "../components/ui";
import { formatDateTime, plural, subjectDisplay } from "../format";
import { listPathWith, type CaptureFilters } from "../mail/captureList";
import { checkingLine, lastCheckLine } from "../mailboxes";
import { useCaptures, useStatus } from "../queries";
import { attention, emailCounts, INVOICE_OUTCOME_LABELS, mailboxState } from "../status";

function Summary({ status }: { status: StatusResponse }) {
  const items = attention(status.mailboxes, status.checking, new Date());
  if (items.length === 0) {
    const last = status.checking.lastFinishedAt;
    return (
      <Notice tone="info" live>
        <span className="inline-flex items-center gap-1.5 font-medium">
          <CircleCheck aria-hidden className="size-4 text-accent" />
          Everything is working.
        </span>
        {last ? <span className="block">Mail was last read {formatDateTime(last)}.</span> : null}
      </Notice>
    );
  }
  return (
    <Notice tone="warning" live>
      <p className="font-medium">{items.length === 1 ? "1 thing needs you:" : `${items.length} things need you:`}</p>
      <ul className="mt-1 list-disc pl-5">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </Notice>
  );
}

const STATE_CLASSES = {
  ok: "border-line bg-surface-muted text-ink",
  warn: "border-warn-line bg-warn-soft text-warn",
  quiet: "border-line bg-surface text-muted",
} as const;

function MailboxStatus({ mailbox, canEdit }: { mailbox: MailboxInfo; canEdit: boolean }) {
  const state = mailboxState(mailbox);
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold wrap-anywhere">{mailbox.name}</h3>
        <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${STATE_CLASSES[state.tone]}`}>{state.label}</span>
        {canEdit ? (
          <Link to={`/settings/mailboxes/${mailbox.id}`} className="ml-auto text-sm font-medium text-accent hover:underline">
            Settings <span className="sr-only">for {mailbox.name}</span>
          </Link>
        ) : null}
      </div>
      <p className="mt-1 text-sm text-muted">{lastCheckLine(mailbox)}</p>
      {mailbox.enabled ? (
        <p className="text-sm text-muted">
          {mailbox.failingSince ? `Failing since ${formatDateTime(mailbox.failingSince)}. ` : ""}
          {mailbox.lastOkAt ? `Last good read ${formatDateTime(mailbox.lastOkAt)}.` : mailbox.lastCheck ? "No good read yet." : ""}
        </p>
      ) : null}
    </li>
  );
}

/** A count; with `list`, a link that opens the captured-mail list narrowed to those emails. */
function Count({ label, value, list, children }: { label: string; value: number; list?: Partial<CaptureFilters>; children?: ReactNode }) {
  return (
    <DetailRow label={label}>
      <span className="font-medium">{value}</span>
      {list && value > 0 ? (
        <Link to={listPathWith(list)} className="ml-3 text-sm font-medium text-accent hover:underline">
          Show<span className="sr-only"> {label.toLowerCase()}</span>
        </Link>
      ) : null}
      {children ? <span className="block text-sm text-muted">{children}</span> : null}
    </DetailRow>
  );
}

function EmailsCard() {
  const captures = useCaptures();
  const counts = captures.data ? emailCounts(captures.data.captures) : null;
  return (
    <Card>
      <h2 className="text-lg font-semibold">Emails</h2>
      {captures.isPending ? <LoadingState label="Counting emails" /> : null}
      {captures.isError ? <ErrorState error={captures.error} onRetry={() => void captures.refetch()} /> : null}
      {counts ? (
        <dl className="mt-2 divide-y divide-line">
          <Count label="Captured" value={counts.total} list={{}} />
          <Count label="Bills" value={counts.bills} list={{ kind: "bill" }} />
          <Count label="To review" value={counts.toReview} list={{ review: "todo" }}>
            Nobody has marked them checked or not a bill yet.
          </Count>
          <Count label="Not a bill" value={counts.notBill} list={{ review: "not-bill" }}>
            Marked by someone in the household. They are never sent to OurHome.
          </Count>
          <Count label="Need a check" value={counts.needsCheck} list={{ needsCheck: true }}>
            The email gives more than one value for something, such as two due dates, and nobody has reviewed it yet.
          </Count>
          <Count label="Past due" value={counts.pastDue} list={{ pastDue: true }} />
          <Count label="Sender not verified" value={counts.senderNotVerified} list={{ unverified: true }}>
            Proton could not confirm who sent them. They are never sent on without a person's OK.
          </Count>
          <Count label="No biller" value={counts.noBiller} list={{ billers: "unmatched" }}>
            <Link to="/billers" className="font-medium text-accent hover:underline">
              Billers
            </Link>{" "}
            decide which emails are whose.
          </Count>
        </dl>
      ) : null}
    </Card>
  );
}

function InvoicesCard({ invoices }: { invoices: StatusResponse["invoices"] }) {
  const tried = INVOICE_OUTCOMES.reduce((sum, outcome) => sum + invoices.counts[outcome], 0) + invoices.retrying;
  return (
    <Card>
      <h2 className="text-lg font-semibold">Invoice links</h2>
      <p className="mt-1 text-sm text-muted">What each email's "View Invoice" link gave, when its sender is verified and its biller allows it.</p>
      {tried === 0 ? (
        <p className="mt-3 text-muted">No invoice link has been opened yet.</p>
      ) : (
        <>
          <dl className="mt-2 divide-y divide-line">
            {INVOICE_OUTCOMES.filter((outcome) => invoices.counts[outcome] > 0).map((outcome) => (
              <Count key={outcome} label={INVOICE_OUTCOME_LABELS[outcome]} value={invoices.counts[outcome]} />
            ))}
            {invoices.retrying > 0 ? <Count label="Tried again later" value={invoices.retrying} /> : null}
          </dl>
          <h3 className="mt-4 font-semibold">Latest</h3>
          <ul className="mt-2 divide-y divide-line border-t border-line">
            {invoices.recent.map((item) => (
              <li key={item.captureId} className="py-2">
                <Link to={capturePagePath(item.captureId)} className="font-medium text-accent wrap-anywhere hover:underline">
                  {subjectDisplay(item.subject)}
                </Link>
                <span className="block text-sm text-muted wrap-anywhere">
                  {item.sender ? `${item.sender}, ` : ""}
                  {formatDateTime(item.triedAt)}: {item.retrying ? "Tried again later" : INVOICE_OUTCOME_LABELS[item.outcome]}
                </span>
                <span className="block text-sm wrap-anywhere">{item.reason}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

function ProblemsCard({ status }: { status: StatusResponse }) {
  const problems = status.problems ?? [];
  return (
    <Card>
      <h2 className="text-lg font-semibold">Recent problems</h2>
      <p className="mt-1 text-sm text-muted">Warnings and errors from the log since OurHomeInbox started, newest first. Only admins see these.</p>
      {problems.length === 0 ? (
        <p className="mt-3 text-muted">None since {formatDateTime(status.startedAt)}.</p>
      ) : (
        <ul className="mt-2 divide-y divide-line border-t border-line">
          {problems.map((problem, index) => (
            <li key={`${problem.at}-${index}`} className="py-2 text-sm">
              <span className={`font-medium ${problem.level === "error" ? "text-danger" : "text-warn"}`}>
                {problem.level === "error" ? "Error" : "Warning"}
              </span>{" "}
              <span className="text-muted">{formatDateTime(problem.at)}</span>
              <span className="block font-mono text-xs wrap-anywhere">{problem.message}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function StatusPage() {
  const status = useStatus();
  useRefreshWhenReadFinishes(status.data?.checking.lastFinishedAt);
  const data = status.data;
  return (
    <div>
      <PageTitle description="Whether OurHomeInbox is reading your mail, and anything that needs you.">Status</PageTitle>
      {status.isPending ? <LoadingState label="Checking" /> : null}
      {status.isError ? <ErrorState error={status.error} onRetry={() => void status.refetch()} /> : null}
      {data ? (
        <div className="flex flex-col gap-5">
          <Summary status={data} />
          <Card>
            <h2 className="text-lg font-semibold">Reading mail</h2>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
              <p className="text-sm text-muted" role="status">
                {checkingLine(data.checking)}
              </p>
              <CheckMailNow checking={data.checking} disabled={data.mailboxes.length === 0} />
            </div>
            <dl className="mt-3 divide-y divide-line">
              <DetailRow label="Last read">{data.checking.lastFinishedAt ? formatDateTime(data.checking.lastFinishedAt) : "Not yet"}</DetailRow>
              <DetailRow label="Running since">{formatDateTime(data.startedAt)}</DetailRow>
              <DetailRow label="Version">{data.version}</DetailRow>
            </dl>
          </Card>
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-semibold">Mailboxes</h2>
              <span className="text-sm text-muted">{plural(data.mailboxes.length, "mailbox", "mailboxes")}</span>
            </div>
            {data.mailboxes.length === 0 ? (
              <p className="mt-3 text-muted">
                No mailboxes yet.{" "}
                {data.canEdit ? (
                  <Link to="/settings/mailboxes/new" className={buttonClasses("secondary", "ml-1 px-3 py-1")}>
                    Add a mailbox
                  </Link>
                ) : (
                  "Ask an admin to add one."
                )}
              </p>
            ) : (
              <ul className="mt-3 divide-y divide-line">
                {data.mailboxes.map((mailbox) => (
                  <MailboxStatus key={mailbox.id} mailbox={mailbox} canEdit={data.canEdit} />
                ))}
              </ul>
            )}
          </Card>
          <EmailsCard />
          <InvoicesCard invoices={data.invoices} />
          {data.problems !== null ? <ProblemsCard status={data} /> : null}
        </div>
      ) : null}
    </div>
  );
}
