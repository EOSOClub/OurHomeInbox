// Export as JSON: the API's names and real types, one object per email.

import { describe, expect, it } from "vitest";
import { exportItem as item, fullItem } from "./exportFixtures";
import { capturesJson, type ExportedFile } from "./exportJson";

describe("capturesJson", () => {
  it("writes each email with the API's names and real types", () => {
    const now = new Date("2026-11-01T16:00:00Z");
    const text = capturesJson([fullItem(), item("8")], now);
    expect(text.endsWith("\n")).toBe(true);
    const file = JSON.parse(text) as ExportedFile;
    expect(file.exportedAt).toBe("2026-11-01T16:00:00.000Z");
    expect(file.count).toBe(2);
    expect(file.emails[0]).toEqual({
      id: "proton-bills/1/7",
      date: "2026-10-20",
      sentAt: "2026-10-20T12:00:00",
      capturedAt: "2026-10-29T15:00:00Z",
      from: [{ name: "City Water", address: "bills@water.example" }],
      subject: "Bill 7",
      biller: "City Water",
      kind: "bill",
      values: {
        amount: ["114.93"],
        fee: ["2.50"],
        dueDate: ["2026-11-04"],
        accountNo: ["0012-3456"],
        invoiceNo: ["INV 88"],
        confirmationNo: ["C77"],
      },
      pastDue: true,
      inDoubt: [],
      review: { state: "checked", by: "Sam", at: "2026-10-30T12:00:00" },
      tags: ["Taxes", "House"],
      senderVerified: true,
      mailbox: "Proton bills",
    });
    expect(file.emails[1]).toMatchObject({ id: "proton-bills/1/8", biller: null, review: null, tags: [], pastDue: false });
  });

  it("names the fields in doubt and keeps every value", () => {
    const doubtful = item("1", {
      picked: { kind: "bill", amount: null, dueDate: null, paidDate: null, dueNow: false, needsCheck: true, values: { amount: ["10.00", "12.00"] } },
    });
    const file = JSON.parse(capturesJson([doubtful])) as ExportedFile;
    expect(file.emails[0]).toMatchObject({ values: { amount: ["10.00", "12.00"] }, inDoubt: ["amount"] });
  });

  it("keeps words from an email exactly as they were", () => {
    const odd = item("1", { subject: '=1+2 "quoted" \n new line' });
    expect((JSON.parse(capturesJson([odd])) as ExportedFile).emails[0]!.subject).toBe('=1+2 "quoted" \n new line');
  });

  it("writes an empty list when there are no emails", () => {
    expect(JSON.parse(capturesJson([]))).toMatchObject({ count: 0, emails: [] });
  });
});
