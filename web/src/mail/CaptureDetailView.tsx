// One captured email: who sent it, when, and where it was found, then tabs
// for each part of what was captured. Takes the API's reply directly, so it
// can be shown (and tested) without fetching anything.

import type { CaptureDetailResponse } from "../../../src/shared/api";
import type { CapturedAddress } from "../../../src/shared/capture";
import { DetailRow } from "../components/ui";
import { Tabs, type TabItem } from "../components/Tabs";
import { formatAddressList, formatDateTime, subjectDisplay } from "../format";
import { AttachmentsPanel, EmailPanel, HeadersPanel, HtmlSourcePanel, LinksPanel, RawPanel, TextPanel } from "./CapturePanels";

function Addresses({ list }: { list: CapturedAddress[] }) {
  return list.length ? <>{formatAddressList(list)}</> : <span className="text-muted">None</span>;
}

export function CaptureDetailView({ detail }: { detail: CaptureDetailResponse }) {
  const { id, capture } = detail;
  const tabs: TabItem[] = [
    { id: "email", label: "Email", render: () => <EmailPanel capture={capture} /> },
    { id: "text", label: "Text", render: () => <TextPanel capture={capture} /> },
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
      </header>
      <Tabs items={tabs} label="Parts of this email" />
    </article>
  );
}
