// How picked-out values are shown: money, days, the list line, shortened
// snippets, and marks for a plain text body.

import { describe, expect, it } from "vitest";
import { extract } from "../../../src/server/extraction";
import { around, formatDay, formatMoney, formatPicked, marksFor, summaryLine, textHighlights } from "./picked";

describe("formatMoney", () => {
  it.each([
    ["114.93", "$114.93"],
    ["1234.50", "$1,234.50"],
    ["0.00", "$0.00"],
    ["-85.27", "$85.27 credit"],
  ])("shows %s as %s", (value, shown) => {
    expect(formatMoney(value)).toBe(shown);
  });
});

describe("formatDay", () => {
  it("shows the same day wherever the browser is", () => {
    expect(formatDay("2026-11-04", "en-US")).toBe("Nov 4, 2026");
    expect(formatDay("2026-01-01", "en-US")).toBe("Jan 1, 2026");
  });

  it("leaves something that is not a day as it is", () => {
    expect(formatDay("soon", "en-US")).toBe("soon");
  });

  it("is used for date fields only", () => {
    expect(formatPicked("dueDate", "2026-11-04", "en-US")).toBe("Nov 4, 2026");
    expect(formatPicked("invoiceNo", "2026-11-04", "en-US")).toBe("2026-11-04");
  });
});

describe("summaryLine", () => {
  it("joins what was found", () => {
    const base = { kind: "bill", amount: null, dueDate: null, paidDate: null, dueNow: false, needsCheck: false } as const;
    expect(summaryLine({ ...base, amount: "4.13", dueDate: "2026-11-04" }, "en-US")).toBe("$4.13, due Nov 4, 2026");
    expect(summaryLine({ ...base, kind: "receipt", amount: "60.00", paidDate: "2026-09-09" }, "en-US")).toBe("$60.00, paid Sep 9, 2026");
    expect(summaryLine(base, "en-US")).toBe("");
  });

  it("says a past due bill is due now, whatever date it prints", () => {
    const base = { kind: "bill", amount: "62.00", dueDate: "2026-11-04", paidDate: null, dueNow: true, needsCheck: false } as const;
    expect(summaryLine(base, "en-US")).toBe("$62.00, due now (past due)");
  });
});

describe("around", () => {
  it("leaves a short piece whole", () => {
    expect(around("Amount Due: $5.00", 12, 17)).toEqual({ text: "Amount Due: $5.00", offset: 0 });
  });

  it("shortens a long piece around the range, and the offset maps back", () => {
    const piece = `${"a".repeat(100)}$5.00${"b".repeat(100)}`;
    const { text, offset } = around(piece, 100, 105, 21);
    expect(text).toBe("…aaaaaaaa$5.00bbbbbbbb…");
    expect(text.slice(100 - offset, 105 - offset)).toBe("$5.00");
  });

  it("does not cut at the start when the range is near it", () => {
    const { text, offset } = around(`$5.00${"b".repeat(100)}`, 0, 5, 20);
    expect(text).toBe(`$5.00${"b".repeat(15)}…`);
    expect(offset).toBe(0);
  });
});

describe("marks", () => {
  it("lists a label and a value for every place a value was found", () => {
    const block = "<table><tr><td>Invoice Amount</td><td>$49.28</td></tr></table>";
    const marks = marksFor(extract({ subject: "Bill", html: block + block, text: null }));
    expect(marks).toEqual([
      { piece: 0, start: 0, end: 14, role: "label", name: "Amount" },
      { piece: 1, start: 0, end: 6, role: "value", name: "Amount" },
      { piece: 2, start: 0, end: 14, role: "label", name: "Amount" },
      { piece: 3, start: 0, end: 6, role: "value", name: "Amount" },
    ]);
  });

  it("finds them in a plain text body by offset", () => {
    const text = "Hello\r\n\r\nAmount  Due:  $5.00\r\n";
    const highlights = textHighlights(text, extract({ subject: "Bill", html: null, text }));
    expect(highlights.map((h) => [text.slice(h.start, h.end), h.tone, h.label])).toEqual([
      ["Amount  Due", "label", "Amount"],
      ["$5.00", "value", "Amount"],
    ]);
  });

  it("has none for a plain text body when the HTML was read", () => {
    expect(textHighlights("Amount Due: $5.00", extract({ subject: "Bill", html: "<p>Amount Due: $5.00</p>", text: "Amount Due: $5.00" }))).toEqual([]);
  });
});
