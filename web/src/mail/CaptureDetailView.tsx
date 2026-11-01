// One captured email: who sent it (and whether that was confirmed), its biller, how it was reviewed, its tags, when, and where it was found,
// what the reader picked out of it, then tabs for each part of what was captured
// (and the invoice its link gave, when there is one). Takes the API's reply directly, so it
// can be shown (and tested) without fetching anything.

import { ShieldAlert, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import type { CaptureDetailResponse } from "../../../src/shared/api";
import type { CapturedAddress } from "../../../src/shared/capture";
import type { SenderCheck } from "../../../src/shared/sender";
import { DetailRow } from "../components/ui";
import { Tabs, type TabItem } from "../components/Tabs";
import { formatAddressList, formatDateTime, subjectDisplay } from "../format";
import { AttachmentsPanel, EmailPanel, HeadersPanel, HtmlSourcePanel, InvoicePanel, LinksPanel, RawPanel, TextPanel } from "./CapturePanels";
import { PickedOut } from "./PickedOut";
import { ReviewSummary } from "./CaptureReview";
import { TagChips } from "./Tags";

function Addresses({ list }: { list: CapturedAddress[] }) {
  return list.length ? <>{formatAddressList(list)}</> : <span className="text-muted">None</span>;
}

/** Whether the mail provider confirmed the sender, and why not when it did not. */
function SenderLine({ check }: { check: SenderCheck }) {
  return (
    <>
      <span className={`flex items-center gap-1.5 font-medium ${check.verified ? "" : "text-warn"}`}>
        {check.verified ? <ShieldCheck aria-hidden className="size-4 shrink-0 text-accent" /> : <ShieldAlert aria-hidden className="size-4 shrink-0" />}
        {check.verified ? `Really from ${check.domain}` : "Not verified"}
      </span>
      <span className="block text-sm text-muted">{check.reason}</span>
    </>
  );
}

/**
 * `actions` go under the email's details, for the page to add buttons that need its router.
 * `tags` replaces the plain list of its tags, for the page to add the tag editor (which needs the server).
 * `review` replaces the plain line saying how it was reviewed, for the page to add the buttons that mark it.
 */
export function CaptureDetailView({
  detail,
  actions,
  tags,
  review,
}: {
  detail: CaptureDetailResponse;
  actions?: ReactNode;
  tags?: ReactNode;
  review?: ReactNode;
}) {
  const { id, capture, extraction } = detail;
  const { invoice } = detail;
  const tabs: TabItem[] = [
    { id: "email", label: "Email", render: () => <EmailPanel capture={capture} extraction={extraction} /> },
    ...(invoice ? [{ id: "invoice", label: "Invoice", render: () => <InvoicePanel id={id} invoice={invoice} extraction={extraction} /> }] : []),
    { id: "text", label: "Text", render: () => <TextPanel capture={capture} extraction={extraction} /> },
    { id: "html", label: "HTML source", render: () => <HtmlSourcePanel capture={capture} /> },
    { id: "headers", label: "Headers", count: capture.headers.length, render: () => <HeadersPanel capture={capture} /> },
    {
      id: "attachments",
      label: "Attachments",
      count: capture.attachments.length,
      render: () => <AttachmentsPanel id={id} capture={capture} />,
    },
    { id: "links", label: "Links", count: capture.links.length, render: () => <LinksPanel capture={capture} /> },
    { id: "raw", label: "Raw email", render: () => <RawPanel id={id} capture={capture} /> },
  ];

  return (
    <article className="flex flex-col gap-5">
      <header className="rounded-lg border border-line bg-surface p-4 sm:p-5">
        <h1 className="text-xl font-semibold tracking-tight wrap-anywhere sm:text-2xl">{subjectDisplay(capture.subject)}</h1>
        <dl className="mt-3 divide-y divide-line">
          <DetailRow label="From">
            <Addresses list={capture.from} />
          </DetailRow>
          <DetailRow label="Sender check">
            <SenderLine check={detail.sender} />
          </DetailRow>
          <DetailRow label="Biller">
            {detail.biller ? (
              <>
                <span className="block font-medium">{detail.biller.name}</span>
                <span className="block text-sm text-muted">Matched on {detail.biller.matchedOn}</span>
              </>
            ) : (
              <span className="text-muted">No biller matches this sender yet</span>
            )}
          </DetailRow>
          <DetailRow label="Review">{review ?? <ReviewSummary review={detail.review} />}</DetailRow>
          <DetailRow label="Tags">
            {tags ?? (detail.tags.length ? <TagChips tags={detail.tags} /> : <span className="text-muted">None</span>)}
          </DetailRow>
          <DetailRow label="To">
            <Addresses list={capture.to} />
          </DetailRow>
          {capture.cc.length ? (
            <DetailRow label="Cc">
              <Addresses list={capture.cc} />
            </DetailRow>
          ) : null}
          {capture.replyTo.length ? (
            <DetailRow label="Reply to">
              <Addresses list={capture.replyTo} />
            </DetailRow>
          ) : null}
          <DetailRow label="Date">
            {capture.date ? formatDateTime(capture.date) : <span className="text-muted">Not given in the email</span>}
          </DetailRow>
          <DetailRow label="Captured">{formatDateTime(capture.capturedAt)}</DetailRow>
          <DetailRow label="Mailbox">
            {capture.mailbox}, folder <span className="font-mono text-sm">{capture.folder}</span>
          </DetailRow>
          <DetailRow label="Message ID">
            {capture.messageId ? (
              <span className="font-mono text-sm break-all">{capture.messageId}</span>
            ) : (
              <span className="text-muted">None</span>
            )}
          </DetailRow>
        </dl>
        {actions ? <div className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3">{actions}</div> : null}
      </header>
      <PickedOut extraction={extraction} captureId={id} biller={detail.biller} />
      <Tabs items={tabs} label="Parts of this email" />
    </article>
  );
}
