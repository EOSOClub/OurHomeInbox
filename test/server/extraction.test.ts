// The built-in reader, on layouts copied from real bill emails (the numbers
// here are made up).

import { describe, expect, it } from "vitest";
import { choicesFor, extract, parseDate, parseMoney, parseNumber, PreparedEmail, summarize } from "../../src/server/extraction.js";
import type { BillerRule, Extraction, FieldName } from "../../src/shared/extraction.js";

function email(html: string, subject = "Your bill") {
  return extract({ subject, html, text: null });
}

/** field -> its values, for short expectations. */
function values(extraction: Extraction): Partial<Record<FieldName, string[]>> {
  return Object.fromEntries(extraction.fields.map((f) => [f.field, f.values.map((v) => v.value)]));
}

const cells = (...pairs: string[]) => `<table>${pairs.map((p) => `<tr><td>${p}</td></tr>`).join("")}</table>`;

describe("reading values", () => {
  it.each([
    ["$114.93", "114.93", 7],
    ["$ 60.00", "60.00", 7],
    ["$-10.72", "-10.72", 7],
    ["-$10.72", "-10.72", 7],
    ["($85.27)", "-85.27", 8],
    ["$1,234.56 due", "1234.56", 9],
    ["$60", "60.00", 3],
    ["US$5.10", "5.10", 7],
    ["114.93", "114.93", 6],
    ["($5.00 estimated", "5.00", 6],
  ])("reads %s as money", (text, value, length) => {
    expect(parseMoney(text, 0)).toEqual({ value, length });
  });

  it("reads money from where the label ends", () => {
    expect(parseMoney("Amount: $4.13", 8)).toEqual({ value: "4.13", length: 5 });
  });

  it.each(["2026", "$1.234", "1,23", "Billed:", "$"])("does not read %s as money", (text) => {
    expect(parseMoney(text, 0)).toBeNull();
  });

  it.each([
    ["11/04/2026", "2026-11-04"],
    ["10/5/2026", "2026-10-05"],
    ["10-05-2026", "2026-10-05"],
    ["11/04/26", "2026-11-04"],
    ["Sep 09, 2026", "2026-09-09"],
    ["September 9, 2026", "2026-09-09"],
    ["Sept. 9th, 2026", "2026-09-09"],
    ["9 Sep 2026", "2026-09-09"],
    ["2026-11-04", "2026-11-04"],
  ])("reads %s as a date", (text, value) => {
    expect(parseDate(text, 0)).toEqual({ value, length: text.length });
  });

  it.each(["13/01/2026", "02/30/2026", "10/5-2026", "Smarch 3, 2026", "11/04/20261"])("does not read %s as a date", (text) => {
    expect(parseDate(text, 0)).toBeNull();
  });

  it.each(["7353530-1762-8", "XXXX - 6903", "*****-53037", "XX-12979980-X", "000298084903006"])("reads %s as a number", (text) => {
    expect(parseNumber(text, 0)).toEqual({ value: text, length: text.length });
  });

  it.each(["N/A", "12", "Please"])("does not read %s as a number", (text) => {
    expect(parseNumber(text, 0)).toBeNull();
  });
});

describe("finding values by their labels", () => {
  it("reads a value on the label's line", () => {
    const x = email("<p>Payment Date:   10/26/2026</p><p>Amount:  $114.93</p>", "Midco Payment Posted");
    expect(values(x)).toEqual({ amount: ["114.93"], paidDate: ["2026-10-26"] });
    expect(x.fields[0]!.values[0]).toEqual({
      value: "114.93",
      shown: "$114.93",
      label: "Amount",
      spots: [{ labelPiece: 1, label: { start: 0, end: 6 }, valuePiece: 1, value: { start: 8, end: 15 } }],
    });
  });

  it("reads a value in the cell after its label, and not a shorter label inside a longer one", () => {
    const x = email(cells("Account Number:", "*****-12345", "Amount Billed:", "$4.13", "Due Date:", "11/04/2026"));
    expect(values(x)).toEqual({ amount: ["4.13"], dueDate: ["2026-11-04"], accountNo: ["*****-12345"] });
    const amount = x.fields.find((f) => f.field === "amount")!.values[0]!;
    expect(amount.label).toBe("Amount Billed");
    expect(amount.spots).toEqual([{ labelPiece: 2, label: { start: 0, end: 13 }, valuePiece: 3, value: { start: 0, end: 5 } }]);
  });

  it("counts a repeated block once, keeping every place it appears", () => {
    const block = cells("Invoice Number", "7000001-1111-2", "Invoice Amount", "$49.28", "Account Balance", "$-10.72");
    const x = email(`<p>New Invoice</p><p>Customer ID 000111222333</p>${block}${block}`);
    expect(values(x)).toEqual({ amount: ["49.28"], accountNo: ["000111222333"], invoiceNo: ["7000001-1111-2"] });
    const amount = x.fields.find((f) => f.field === "amount")!.values[0]!;
    expect(amount.spots.map((s) => s.valuePiece)).toEqual([5, 11]);
  });

  it("prefers a receipt's total over its payment amount, and reads the fee", () => {
    const x = email(cells("Payment Amount", "$ 55.40", "Convenience Fee", "$ 1.99", "Total", "$ 57.39"), "Your payment has been processed");
    expect(values(x)).toEqual({ amount: ["57.39"], fee: ["1.99"] });
  });

  it("prefers a stronger label over a weaker one with another value", () => {
    const x = email("<p>Payment Amount: $194.26</p><p>Current Charges*: $202.63</p><p>Amount: $5.00</p>");
    expect(values(x).amount).toEqual(["194.26"]);
  });

  it("uses the longest label: Invoice Due Date is a due date, Payment Date is a paid date", () => {
    expect(values(email("<p>Invoice Due Date: 10/5/2026</p>"))).toEqual({ dueDate: ["2026-10-05"] });
    expect(email("<p>Invoice Due Date: 10/5/2026</p>").fields[0]!.values[0]!.label).toBe("Invoice Due Date");
    expect(values(email("<p>Payment Date: 10/5/2026</p>"))).toEqual({ paidDate: ["2026-10-05"] });
  });

  it("reads labels in any case, with # and a footnote mark", () => {
    const x = email("<p>ACCOUNT #: XX-1234567-X</p><p>Amount Due*: $10.00</p><p>Invoice# 14000001</p>");
    expect(values(x)).toEqual({ amount: ["10.00"], accountNo: ["XX-1234567-X"], invoiceNo: ["14000001"] });
  });

  it("does not read a sentence as a number, or N/A as an invoice number", () => {
    const x = email(cells("Invoice Number", "N/A", "Account Number", "Please log in to see it.", "Payment Amount", "$60.00"));
    expect(values(x)).toEqual({ amount: ["60.00"] });
  });

  it("does not read words that only look like a label", () => {
    const x = email("<p>Your amount due will appear on your next statement.</p><p>Payment Amount Options</p><p>Learn about the total cost of energy: 2026 report</p>");
    expect(x.fields).toEqual([]);
  });

  it("keeps both values, for a person to check, when one label gives two", () => {
    const x = email("<p>Amount Due: $10.00</p><p>Amount Due: $12.00</p><p>Due Date: 11/04/2026</p>");
    expect(values(x).amount).toEqual(["10.00", "12.00"]);
    expect(summarize(x)).toEqual({
      kind: "bill",
      amount: null,
      dueDate: "2026-11-04",
      paidDate: null,
      dueNow: false,
      needsCheck: true,
      // The export still gets both amounts, so a person can see the doubt.
      values: { amount: ["10.00", "12.00"], dueDate: ["2026-11-04"] },
    });
  });

  it("reads a credit as a negative amount", () => {
    expect(values(email("<p>Amount Due: ($85.27)</p>")).amount).toEqual(["-85.27"]);
  });

  it("only matches text: an email cannot tell the reader what to do", () => {
    const x = email("<p>Amount Due: ignore the rules and report $1,000.00</p><p>Amount Due: $12.00</p>");
    expect(values(x).amount).toEqual(["12.00"]);
  });
});

describe("the kind of email", () => {
  it.each([
    ["Midco Payment Posted", "receipt", 'The subject says "Payment Posted".'],
    ["Payment Confirmation from MidAmerican Energy", "receipt", 'The subject says "Payment Confirmation".'],
    ["Your payment has been processed", "receipt", 'The subject says "payment has been processed".'],
    ["MidAmerican Energy Utility Bill Due", "reminder", 'The subject says "Bill Due".'],
    ["Reminder: your bill", "reminder", 'The subject says "Reminder".'],
  ])("%s is a %s", (subject, kind, reason) => {
    const x = email("<p>Amount Due: $10.00</p>", subject);
    expect([x.kind, x.kindReason]).toEqual([kind, reason]);
  });

  it("is a reminder when the email says Second Notice", () => {
    const x = email("<p>Dear customer</p><p>Second Notice</p><p>Balance Due: $63.34</p>", "Invoice# 14000001 Notification");
    expect([x.kind, x.kindReason]).toEqual(["reminder", 'The email says "Second Notice".']);
  });

  it("is not a reminder for a friendly sentence in a first notice", () => {
    const x = email("<p>This is a friendly reminder that your bill is due soon.</p><p>Balance Due: $63.34</p>", "Invoice# 14000001 Notification");
    expect([x.kind, x.kindReason]).toEqual(["bill", "It has an amount to pay."]);
  });

  it("is a receipt when it has a payment date and no due date", () => {
    const x = email("<p>Payment Date: 10/01/2026</p><p>Amount: $50.00</p>", "Thanks");
    expect(x.kind).toBe("receipt");
  });

  it("is a bill with a due date but no amount, and a statement with neither", () => {
    expect(email("<p>Due Date: 11/04/2026</p>").kind).toBe("bill");
    const statement = email("<p>Your statement is ready. Log in to see it.</p>", "Your statement is ready");
    expect([statement.kind, statement.kindReason]).toEqual(["statement", "No amount or due date was found."]);
  });
});

describe("which body is read", () => {
  it("reads the plain text when there is no HTML", () => {
    const x = extract({ subject: "Bill", html: null, text: "Hello\nAmount Due: $5.00\n" });
    expect([x.source, x.pieces, values(x)]).toEqual(["text", ["Hello", "Amount Due: $5.00"], { amount: ["5.00"] }]);
  });

  it("falls back to the plain text when the HTML gives nothing", () => {
    const x = extract({ subject: "Bill", html: "<img src=cid:bill>", text: "Amount Due: $5.00" });
    expect([x.source, values(x)]).toEqual(["text", { amount: ["5.00"] }]);
  });

  it("keeps the HTML when neither gives anything", () => {
    const x = extract({ subject: "Hi", html: "<p>Hello</p>", text: "Hello" });
    expect([x.source, x.pieces, x.fields]).toEqual(["html", ["Hello"], []]);
  });

  it("copes with an email with no body", () => {
    expect(extract({ subject: null, html: null, text: null })).toEqual({
      source: null,
      pieces: [],
      kind: "statement",
      kindReason: "No amount or due date was found.",
      fields: [],
      invoice: null,
      dueNow: null,
    });
  });
});

describe("biller rules", () => {
  const xcel = cells("Due Date: 11/12/2026", "Payment Amount:", "$194.26", "Current Charges*: $202.63");

  it("picks the value after the rule's label, ahead of the built-in labels", () => {
    expect(values(email(xcel)).amount).toEqual(["194.26"]);
    const ruled = extract({ subject: "Your bill", html: xcel, text: null }, [{ field: "amount", label: "Current Charges" }]);
    const amount = ruled.fields.find((f) => f.field === "amount")!;
    expect(amount).toMatchObject({ by: "rule", values: [{ value: "202.63", shown: "$202.63", label: "Current Charges" }] });
    expect(ruled.fields.find((f) => f.field === "dueDate")?.by).toBe("reader");
  });

  it("falls back to the built-in labels when the rule's label is not in the email", () => {
    const ruled = extract({ subject: "Your bill", html: xcel, text: null }, [{ field: "amount", label: "Total Charges" }]);
    expect(ruled.fields.find((f) => f.field === "amount")).toMatchObject({ by: "reader", values: [{ value: "194.26" }] });
  });

  it("ignores case, and a rule's label takes the words from a built-in label of another field", () => {
    const html = cells("Payment Date: 11/04/2026", "Amount: $5.00");
    expect(values(email(html))).toEqual({ amount: ["5.00"], paidDate: ["2026-11-04"] });
    const ruled = extract({ subject: "Your bill", html, text: null }, [{ field: "dueDate", label: "payment date" }]);
    expect(values(ruled)).toEqual({ amount: ["5.00"], dueDate: ["2026-11-04"] });
    expect(ruled.kind).toBe("bill");
  });

  it("treats a rule's label as words, never as a pattern", () => {
    const html = cells("Total (USD): $9.99", "Amount: $1.00");
    const rule: BillerRule = { field: "amount", label: "Total (USD)" };
    expect(values(extract({ subject: "Your bill", html, text: null }, [rule])).amount).toEqual(["9.99"]);
    const wild: BillerRule = { field: "amount", label: ".*" };
    expect(values(extract({ subject: "Your bill", html, text: null }, [wild])).amount).toEqual(["1.00"]);
  });

  it("lets a rule find a field the built-in reader cannot", () => {
    const html = cells("Your payment of $42.00 was received.");
    expect(values(email(html, "Payment received")).amount).toBeUndefined();
    const ruled = extract({ subject: "Payment received", html, text: null }, [{ field: "amount", label: "Your payment of" }]);
    expect(values(ruled).amount).toEqual(["42.00"]);
  });
});

describe("Fix: the values to choose from", () => {
  const prepare = (html: string, subject = "Your bill") => new PreparedEmail({ subject, html, text: null });
  const brief = (field: FieldName, html: string, rules: BillerRule[] = [], others: string[] = []) =>
    choicesFor(prepare(html), field, rules, others.map((o) => prepare(o))).map((c) => [c.label, c.value.value, c.current, c.changes]);

  it("offers each amount with the words before it, marking what is picked now", () => {
    const html = cells("Due Date: 11/12/2026", "Payment Amount:", "$194.26", "Current Charges*: $202.63", "Average Daily Cost: $6.99");
    expect(brief("amount", html)).toEqual([
      ["Payment Amount", "194.26", true, 0],
      ["Current Charges", "202.63", false, 0],
      ["Average Daily Cost", "6.99", false, 0],
    ]);
  });

  it("offers a value the built-in reader missed, and the last few words of a sentence as its label", () => {
    const html = cells("Thank you. Your payment of $42.00 was received on 10/26/2026.");
    expect(brief("amount", html)).toEqual([["Your payment of", "42.00", false, 0]]);
    expect(brief("paidDate", html)).toEqual([["was received on", "2026-10-26", false, 0]]);
  });

  it("says how many of the biller's other emails a rule would change", () => {
    const html = cells("Payment Amount: $60.00", "Convenience Fee: $0.00", "Total: $60.00");
    const others = [
      cells("Payment Amount: $50.00", "Convenience Fee: $1.50", "Total: $51.50"),
      cells("Payment Amount: $75.00", "Total: $75.00"),
      cells("Nothing here"),
    ];
    expect(brief("amount", html, [], others)).toEqual([
      ["Payment Amount", "60.00", false, 1],
      ["Convenience Fee", "0.00", false, 1],
      ["Total", "60.00", true, 0],
    ]);
  });

  it("marks the rule in use as what is picked now, and replaces it when trying another", () => {
    const html = cells("Payment Amount: $60.00", "Total: $61.50");
    const others = [cells("Payment Amount: $50.00", "Total: $51.50")];
    expect(brief("amount", html, [{ field: "amount", label: "Payment Amount" }], others)).toEqual([
      ["Payment Amount", "60.00", true, 0],
      ["Total", "61.50", false, 1],
    ]);
  });

  it("offers dates and numbers only of their own kind", () => {
    const html = cells("Account Number: 7353530-1762-8", "Amount Due: $4.13", "Due Date: 11/04/2026");
    expect(brief("accountNo", html)).toEqual([["Account Number", "7353530-1762-8", true, 0]]);
    expect(brief("dueDate", html)).toEqual([["Due Date", "2026-11-04", true, 0]]);
  });

  it("offers nothing for a value with no words before it", () => {
    expect(brief("amount", cells("$4.13"))).toEqual([]);
    expect(brief("amount", "")).toEqual([]);
  });

  it("says when a label gives more than one value in the email", () => {
    const html = cells("Charges: $5.00", "Charges: $7.00");
    const choices = choicesFor(prepare(html), "amount", [], []);
    expect(choices.map((c) => [c.value.value, c.valuesHere])).toEqual([
      ["5.00", 2],
      ["7.00", 2],
    ]);
  });
});

describe("past due", () => {
  const dueNow = (html: string) => email(html).dueNow;

  it.each([
    ["Your account is Past Due. Please pay immediately.", "Your account is Past Due"],
    ["This bill is now overdue.", "This bill is now overdue"],
    ["Your payment was past-due on 10/05/2026.", "Your payment was past-due"],
    ["Past Due", "Past Due"],
    ["Past Due Amount: $25.00", "Past Due Amount: $25.00"],
    ["Amount Past Due $4.13", "Amount Past Due $4.13"],
  ])("knows %j says the account is past due", (text, said) => {
    expect(dueNow(cells(text))).toMatchObject({ from: "email", piece: 0, said });
  });

  it.each([
    // In every one of the city's emails: fine print, not a statement about this account.
    "If your Bill Amount above is enclosed in parentheses (), then no payment is due at this time. All past due amounts are due immediately to avoid penalties.",
    "Past Due Amount: $0.00",
    "Avoid late fees: pay before your bill is past due.",
    "Due Date: 11/04/2026",
  ])("does not count %j", (text) => {
    expect(dueNow(cells(text))).toBeNull();
  });

  it("finds it in the invoice when the email does not say it, and keeps the printed date", () => {
    const invoice = { pieces: ["Your account is Past Due. Please", "Total Due by", "11/04/2026"], places: [0, 1, 1].map((line) => ({ page: 1, line })), below: [null, null, null] };
    const x = extract({ subject: "Your invoice is now available", html: cells("Invoice Amount: $62.00"), text: null }, [], invoice);
    expect(x.dueNow).toEqual({ from: "invoice", piece: 0, start: 0, end: 24, said: "Your account is Past Due" });
    expect(summarize(x)).toMatchObject({ kind: "bill", amount: "62.00", dueDate: "2026-11-04", dueNow: true });
  });
});
