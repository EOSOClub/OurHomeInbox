// The tab panels of one captured email: the email itself, its plain text,
// its HTML source, headers, attachments, links and the original file.
// Each takes the capture record and shows one part of it.

import { Download, FileText, Paperclip } from "lucide-react";
import { useId, useMemo, useState } from "react";
import type { Capture } from "../../../src/shared/capture";
import type { Extraction } from "../../../src/shared/extraction";
import type { InvoiceInfo } from "../../../src/shared/invoice";
import { captureAttachmentUrl, captureInvoiceUrl, captureRawUrl } from "../api";
import { buttonClasses, CopyButton, Notice } from "../components/ui";
import { formatBytes, formatDateTime, shortHash, subjectDisplay } from "../format";
import { invoiceLayout, marksFor, textHighlights } from "./picked";
import { SafeEmailFrame } from "./SafeEmailFrame";
import { TextBlock } from "./TextBlock";

function Empty({ children }: { children: string }) {
  return <p className="py-4 text-muted">{children}</p>;
}

/** The email as its sender made it, with the picked-out values marked (a box turns the marks off). */
export function EmailPanel({ capture, extraction }: { capture: Capture; extraction?: Extraction }) {
  const [showMarks, setShowMarks] = useState(true);
  const checkboxId = useId();
  const marks = useMemo(
    () => (extraction?.source === "html" ? { pieces: extraction.pieces, marks: marksFor(extraction) } : undefined),
    [extraction],
  );
  const highlights = useMemo(() => (capture.text && extraction ? textHighlights(capture.text, extraction) : []), [capture.text, extraction]);
  const hasMarks = (marks?.marks.length ?? 0) > 0 || (!capture.html && highlights.length > 0);

  const toggle = hasMarks ? (
    <label htmlFor={checkboxId} className="inline-flex items-center gap-2 text-sm">
      <input id={checkboxId} type="checkbox" checked={showMarks} onChange={(e) => setShowMarks(e.target.checked)} className="size-4 accent-accent" />
      Mark the picked-out values
    </label>
  ) : null;

  if (capture.html) {
    return (
      <div className="flex flex-col gap-3">
        {toggle}
        <SafeEmailFrame html={capture.html} title={`Email: ${subjectDisplay(capture.subject)}`} marks={showMarks ? marks : undefined} />
      </div>
    );
  }
  if (capture.text) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted">This email has no HTML version, so its plain text is shown.</p>
        {toggle}
        <TextBlock text={capture.text} highlights={showMarks ? highlights : undefined} label="Email text" />
      </div>
    );
  }
  return <Empty>This email has no body text.</Empty>;
}

export function TextPanel({ capture, extraction }: { capture: Capture; extraction?: Extraction }) {
  const highlights = useMemo(() => (capture.text && extraction ? textHighlights(capture.text, extraction) : []), [capture.text, extraction]);
  if (!capture.text) return <Empty>This email has no plain text part.</Empty>;
  return <TextBlock text={capture.text} highlights={highlights} label="Plain text body" />;
}

export function HtmlSourcePanel({ capture }: { capture: Capture }) {
  if (!capture.html) return <Empty>This email has no HTML part.</Empty>;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted">The email's HTML code, shown as text.</p>
      <TextBlock text={capture.html} label="HTML source" />
    </div>
  );
}

export function HeadersPanel({ capture }: { capture: Capture }) {
  if (capture.headers.length === 0) return <Empty>No headers were saved for this email.</Empty>;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted">Every header line, in the order the email arrived with them.</p>
      <ol className="divide-y divide-line rounded-md border border-line">
        {capture.headers.map((header, index) => (
          <li key={index} className="px-3 py-2">
            <div className="text-sm font-semibold">{header.name}</div>
            <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-xs text-muted">{header.line}</pre>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Fingerprint({ sha256, what }: { sha256: string; what: string }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <code title={sha256} className="rounded bg-surface-muted px-1.5 py-0.5 font-mono text-xs">
        {shortHash(sha256)}
      </code>
      <CopyButton text={sha256} label={`Copy the full fingerprint of ${what}`} />
    </span>
  );
}

/** The invoice behind the email's "View Invoice" link: what happened, the PDF to download, and its text with the picked values marked. */
export function InvoicePanel({ id, invoice, extraction }: { id: string; invoice: InvoiceInfo; extraction: Extraction }) {
  const { text, highlights } = useMemo(() => invoiceLayout(extraction), [extraction]);
  return (
    <div className="flex flex-col gap-3">
      <Notice tone={invoice.outcome === "saved" ? "info" : "warning"}>
        <p>{invoice.reason}</p>
        <p className="mt-1 text-muted">Tried {formatDateTime(invoice.triedAt)}.</p>
      </Notice>
      {invoice.file ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <a href={captureInvoiceUrl(id)} download className={buttonClasses("secondary")}>
            <Download aria-hidden className="size-4" />
            Download the invoice (PDF)
          </a>
          {invoice.size !== null ? <span className="text-sm text-muted">{formatBytes(invoice.size)}</span> : null}
        </div>
      ) : null}
      {text ? (
        <>
          <p className="text-sm text-muted">The invoice's text, as OurHomeInbox reads it. Values picked out of it are marked.</p>
          <TextBlock text={text} highlights={highlights} label="The invoice's text" />
        </>
      ) : null}
    </div>
  );
}

export function AttachmentsPanel({ id, capture }: { id: string; capture: Capture }) {
  if (capture.attachments.length === 0) return <Empty>This email has no attachments.</Empty>;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted">Only open attachments from senders you trust.</p>
      <ul className="flex flex-col gap-3">
        {capture.attachments.map((attachment, index) => {
          const name = attachment.filename?.trim() || "(no name)";
          return (
            <li key={index} className="rounded-md border border-line p-3">
              <div className="flex items-start gap-2">
                <Paperclip aria-hidden className="mt-1 size-4 shrink-0 text-muted" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium wrap-anywhere">{name}</p>
                  <p className="text-sm text-muted wrap-anywhere">
                    {attachment.contentType}, {formatBytes(attachment.size)}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                    <span className="text-muted">Fingerprint (SHA-256):</span>
                    <Fingerprint sha256={attachment.sha256} what={name} />
                  </div>
                </div>
              </div>
              <a href={captureAttachmentUrl(id, index + 1)} download className={buttonClasses("secondary", "mt-3")}>
                <Download aria-hidden className="size-4" />
                Download <span className="sr-only">{name}</span>
              </a>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function LinksPanel({ capture }: { capture: Capture }) {
  if (capture.links.length === 0) return <Empty>This email has no links.</Empty>;
  return (
    <div className="flex flex-col gap-3">
      <Notice tone="info">
        Links are shown as text and cannot be opened from here, because bill emails can contain payment or unsubscribe
        links. Copy one if you need it.
      </Notice>
      <ul className="flex flex-col gap-3">
        {capture.links.map((link, index) => (
          <li key={index} className="rounded-md border border-line p-3">
            <code className="block break-all font-mono text-sm">{link.url}</code>
            {link.text?.trim() ? <p className="mt-1 text-sm wrap-anywhere">Link text: {link.text}</p> : null}
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm text-muted">
                {link.source === "html" ? "Found in the HTML version" : "Found in the plain text version"}
              </span>
              <CopyButton text={link.url} label={`Copy link ${index + 1}`} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function RawPanel({ id, capture }: { id: string; capture: Capture }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted">The email exactly as it arrived, before OurHomeInbox read it.</p>
      <dl className="flex flex-col gap-2 text-sm">
        <div>
          <dt className="text-muted">Size</dt>
          <dd>{formatBytes(capture.raw.size)}</dd>
        </div>
        <div>
          <dt className="text-muted">Fingerprint (SHA-256)</dt>
          <dd className="flex flex-wrap items-center gap-2">
            <code className="break-all font-mono text-xs">{capture.raw.sha256}</code>
            <CopyButton text={capture.raw.sha256} label="Copy the fingerprint of the original email" />
          </dd>
        </div>
      </dl>
      <div>
        <a href={captureRawUrl(id)} download className={buttonClasses("secondary")}>
          <FileText aria-hidden className="size-4" />
          Download the original email (.eml)
        </a>
      </div>
    </div>
  );
}
