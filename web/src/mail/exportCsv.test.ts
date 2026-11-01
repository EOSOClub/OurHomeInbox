// Export as CSV: the row each email becomes (columns, quoting, the formula
// guard on words from strangers' email).

import { describe, expect, it } from "vitest";
import { COLUMNS } from "./exportColumns";
import { capturesCsv, csvCell } from "./exportCsv";
import { exportItem as item, fullItem } from "./exportFixtures";

/** The CSV's rows as arrays of raw cells (no cell here holds a comma inside quotes). */
function table(csv: string): string[][] {
  return csv
    .split("\r\n")
    .filter((line) => line !== "")
    .map((line) => line.split(","));
}

/** One email's row as heading -> cell. */
function rowOf(csv: string, index = 0): Record<string, string> {
  const [headings, ...rows] = table(csv);
  return Object.fromEntries(headings!.map((h, i) => [h, rows[index]![i]!]));
}

describe("capturesCsv", () => {
  it("writes a heading row and one row per email, with everything picked out", () => {
    const csv = capturesCsv([fullItem(), item("8")]);
    expect(table(csv)[0]).toEqual(COLUMNS.map((c) => c.heading));
    expect(table(csv)).toHaveLength(3);
    expect(rowOf(csv)).toEqual({
      Date: "2026-10-20",
      From: "City Water",
      "From address": "bills@water.example",
      Subject: "Bill 7",
      Biller: "City Water",
      Kind: "Bill",
      Amount: "114.93",
      Fee: "2.50",
      "Due date": "2026-11-04",
      "Paid on": "",
      "Account number": "0012-3456",
      "Invoice number": "INV 88",
      "Confirmation number": "C77",
      "Past due": "Yes",
      "Values in doubt": "",
      Review: "Checked",
      "Reviewed by": "Sam",
      "Reviewed on": "2026-10-30",
      Tags: "Taxes; House",
      "Sender verified": "Yes",
      Mailbox: "Proton bills",
      "Email id": "proton-bills/1/7",
    });
  });

  it("lists every value of a field in doubt, and names the fields in doubt", () => {
    const doubtful = item("1", {
      picked: { kind: "bill", amount: null, dueDate: null, paidDate: null, dueNow: false, needsCheck: true, values: { amount: ["10.00", "12.00"] } },
    });
    expect(rowOf(capturesCsv([doubtful]))).toMatchObject({ Amount: "10.00 or 12.00", "Values in doubt": "Amount" });
  });

  it("says To review, and leaves out who marked it when that account is gone", () => {
    expect(rowOf(capturesCsv([item("1")]))).toMatchObject({ Review: "To review", "Reviewed by": "", "Reviewed on": "" });
    const gone = item("2", { review: { state: "not-bill", by: null, at: "2026-10-30T12:00:00" } });
    expect(rowOf(capturesCsv([gone]))).toMatchObject({ Review: "Not a bill", "Reviewed by": "", "Reviewed on": "2026-10-30" });
  });

  it("keeps a spreadsheet from running words from an email as a formula", () => {
    const sneaky = item("1", {
      subject: "=1+2",
      from: [{ name: "@SUM(A1)", address: "+x@evil.example" }],
      tags: [{ id: 1, name: "-tag" }],
      mailbox: "\tTabbed",
      picked: { kind: "bill", amount: null, dueDate: null, paidDate: null, dueNow: false, needsCheck: false, values: { accountNo: ["-5+5"] } },
    });
    const row = rowOf(capturesCsv([sneaky]));
    expect(row).toMatchObject({ Subject: "'=1+2", From: "'@SUM(A1)", "From address": "'+x@evil.example", Tags: "'-tag", "Account number": "'-5+5" });
    expect(row.Mailbox).toBe("'\tTabbed");
  });

  it("leaves OurHomeInbox's own money as a number, a credit too, but guards money in doubt", () => {
    const credit = item("1", {
      picked: { kind: "bill", amount: "-85.27", dueDate: null, paidDate: null, dueNow: false, needsCheck: false, values: { amount: ["-85.27"] } },
    });
    expect(rowOf(capturesCsv([credit])).Amount).toBe("-85.27");
    const doubtful = item("2", {
      picked: { kind: "bill", amount: null, dueDate: null, paidDate: null, dueNow: false, needsCheck: true, values: { amount: ["-85.27", "12.00"] } },
    });
    expect(rowOf(capturesCsv([doubtful])).Amount).toBe("'-85.27 or 12.00");
  });

  it("quotes cells with commas, quotes, line breaks or spaces at either end", () => {
    expect(csvCell('Your bill, "final"', true)).toBe('"Your bill, ""final"""');
    expect(csvCell("two\nlines", true)).toBe('"two\nlines"');
    expect(csvCell(" padded", true)).toBe('" padded"');
    expect(csvCell("plain", true)).toBe("plain");
    // Guarded first, then quoted.
    expect(csvCell("=A1,B1", true)).toBe(`"'=A1,B1"`);
    // Not words from an email: left alone.
    expect(csvCell("-85.27", false)).toBe("-85.27");
  });

  it("ends every line with CRLF, the last one too", () => {
    const csv = capturesCsv([item("1")]);
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(csv.split("\r\n")).toHaveLength(3);
    expect(csv.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  });

  it("writes just the heading row when there are no emails", () => {
    expect(table(capturesCsv([]))).toEqual([COLUMNS.map((c) => c.heading)]);
  });
});
