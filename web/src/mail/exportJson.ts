// Export as JSON: for a program rather than a person, so the names are the
// API's (amount, dueDate, not-bill) and values keep their own types (true,
// null, lists), not the words a spreadsheet column shows.

import type { CaptureListItem, CaptureReview } from "../../../src/shared/api";
import type { CapturedAddress } from "../../../src/shared/capture";
import { FIELDS, type EmailKind, type FieldName } from "../../../src/shared/extraction";
import { captureDate, localDay } from "./captureList";
import { inDoubt } from "./exportColumns";

export interface ExportedEmail {
  /** The capture id, as in the API. */
  id: string;
  /** The day the list shows, in the browser's time zone. */
  date: string;
  /** The email's own Date header (ISO), or null when it has no usable one. */
  sentAt: string | null;
  capturedAt: string;
  from: CapturedAddress[];
  subject: string | null;
  biller: string | null;
  kind: EmailKind;
  /** Every value found, by field: money as "114.93", days as "2026-11-04", numbers as written. More than one means in doubt. */
  values: Partial<Record<FieldName, string[]>>;
  pastDue: boolean;
  /** The fields with more than one value. */
  inDoubt: FieldName[];
  review: CaptureReview | null;
  tags: string[];
  senderVerified: boolean;
  mailbox: string;
}

export interface ExportedFile {
  exportedAt: string;
  count: number;
  emails: ExportedEmail[];
}

export function exportedEmail(item: CaptureListItem): ExportedEmail {
  return {
    id: item.id,
    date: localDay(captureDate(item)),
    sentAt: item.date,
    capturedAt: item.capturedAt,
    from: item.from,
    subject: item.subject,
    biller: item.biller?.name ?? null,
    kind: item.picked.kind,
    values: item.picked.values,
    pastDue: item.picked.dueNow,
    inDoubt: FIELDS.filter((field) => inDoubt(item, field)),
    review: item.review,
    tags: item.tags.map((tag) => tag.name),
    senderVerified: item.senderVerified,
    mailbox: item.mailbox,
  };
}

/** The JSON for these emails, in this order, indented to be readable. */
export function capturesJson(items: readonly CaptureListItem[], now: Date = new Date()): string {
  const file: ExportedFile = { exportedAt: now.toISOString(), count: items.length, emails: items.map(exportedEmail) };
  return `${JSON.stringify(file, null, 2)}\n`;
}
