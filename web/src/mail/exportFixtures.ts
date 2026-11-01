// A captured email as the list has it, for the export tests.

import type { CaptureListItem } from "../../../src/shared/api";

export function exportItem(id: string, more: Partial<CaptureListItem> = {}): CaptureListItem {
  return {
    id: `proton-bills/1/${id}`,
    mailbox: "Proton bills",
    mailboxSlug: "proton-bills",
    folder: "Folders/Bills",
    uidValidity: "1",
    uid: Number(id),
    subject: `Bill ${id}`,
    from: [{ name: "City Water", address: "bills@water.example" }],
    // Local noon, so the day holds in any time zone.
    date: "2026-10-20T12:00:00",
    capturedAt: "2026-10-29T15:00:00Z",
    attachmentCount: 0,
    linkCount: 0,
    hasText: true,
    hasHtml: false,
    biller: null,
    senderVerified: true,
    picked: { kind: "bill", amount: "42.10", dueDate: null, paidDate: null, dueNow: false, needsCheck: false, values: { amount: ["42.10"] } },
    tags: [],
    review: null,
    ...more,
  };
}

/** An email with something in every column. */
export function fullItem(): CaptureListItem {
  return exportItem("7", {
    biller: { id: 1, name: "City Water", kind: "bill", matchedOn: "water.example" },
    picked: {
      kind: "bill",
      amount: "114.93",
      dueDate: "2026-11-04",
      paidDate: null,
      dueNow: true,
      needsCheck: false,
      values: {
        amount: ["114.93"],
        fee: ["2.50"],
        dueDate: ["2026-11-04"],
        accountNo: ["0012-3456"],
        invoiceNo: ["INV 88"],
        confirmationNo: ["C77"],
      },
    },
    tags: [
      { id: 1, name: "Taxes" },
      { id: 2, name: "House" },
    ],
    review: { state: "checked", by: "Sam", at: "2026-10-30T12:00:00" },
  });
}

/** A saved file's bytes, from a Blob (jsdom has FileReader, not Blob.arrayBuffer everywhere). */
export function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

/** A saved file's text exactly as its bytes say, byte order mark kept (reading it as text would drop the mark). */
export async function blobText(blob: Blob): Promise<string> {
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(await blobBytes(blob));
}
