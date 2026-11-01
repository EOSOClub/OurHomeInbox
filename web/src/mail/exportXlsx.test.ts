// @vitest-environment jsdom
// Export as an Excel workbook: the parts of the .xlsx file, each cell's type
// (days as dates, money as numbers, words as text), column widths, the
// frozen heading row and filter, and text Excel could not open.

import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { COLUMNS } from "./exportColumns";
import { exportItem as item, fullItem } from "./exportFixtures";
import { capturesXlsx, columnName, excelDay, SHEET_NAME, xmlText } from "./exportXlsx";

const parts = (bytes: Uint8Array) => Object.fromEntries(Object.entries(unzipSync(bytes)).map(([name, data]) => [name, strFromU8(data)]));

function xml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  expect(doc.getElementsByTagName("parsererror")).toHaveLength(0);
  return doc;
}

/** The sheet's cells by reference: their type attribute, style and value or text. */
function cells(bytes: Uint8Array): Map<string, { t: string | null; s: string | null; value: string }> {
  const sheet = xml(parts(bytes)["xl/worksheets/sheet1.xml"]!);
  const found = new Map<string, { t: string | null; s: string | null; value: string }>();
  for (const c of Array.from(sheet.getElementsByTagName("c"))) {
    const value = c.getAttribute("t") === "inlineStr" ? (c.getElementsByTagName("t")[0]?.textContent ?? "") : (c.getElementsByTagName("v")[0]?.textContent ?? "");
    found.set(c.getAttribute("r")!, { t: c.getAttribute("t"), s: c.getAttribute("s"), value });
  }
  return found;
}

/** The reference of a heading's cell in a row. */
const ref = (heading: string, row: number) => `${columnName(COLUMNS.findIndex((c) => c.heading === heading))}${row}`;

describe("capturesXlsx", () => {
  it("is a zip of the parts Excel needs, every one well-formed XML", () => {
    const files = parts(capturesXlsx([item("1")]));
    expect(Object.keys(files).sort()).toEqual(
      ["[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml"].sort(),
    );
    for (const text of Object.values(files)) xml(text);
    expect(files["xl/workbook.xml"]).toContain(`<sheet name="${SHEET_NAME}"`);
  });

  it("writes days as dates and money as numbers, so Excel shows and sorts them as such", () => {
    const c = cells(capturesXlsx([fullItem()]));
    // Days: Excel's day number with the short date style (3).
    expect(c.get(ref("Date", 2))).toEqual({ t: null, s: "3", value: "46315" });
    expect(c.get(ref("Due date", 2))).toEqual({ t: null, s: "3", value: "46330" });
    expect(c.get(ref("Reviewed on", 2))).toEqual({ t: null, s: "3", value: "46325" });
    // Money: a number with two decimals (style 2).
    expect(c.get(ref("Amount", 2))).toEqual({ t: null, s: "2", value: "114.93" });
    expect(c.get(ref("Fee", 2))).toEqual({ t: null, s: "2", value: "2.5" });
    // Words, account numbers too, so their leading zeros stay.
    expect(c.get(ref("Account number", 2))).toEqual({ t: "inlineStr", s: null, value: "0012-3456" });
    expect(c.get(ref("Subject", 2))).toMatchObject({ t: "inlineStr", value: "Bill 7" });
    expect(c.get(ref("Tags", 2))).toMatchObject({ t: "inlineStr", value: "Taxes; House" });
    // Empty cells are left out.
    expect(c.has(ref("Paid on", 2))).toBe(false);
  });

  it("has a bold heading row, held in view, with filter buttons, and a width for every column", () => {
    const bytes = capturesXlsx([item("1"), item("2")]);
    const c = cells(bytes);
    COLUMNS.forEach((column, i) => expect(c.get(`${columnName(i)}1`)).toEqual({ t: "inlineStr", s: "1", value: column.heading }));
    const sheet = xml(parts(bytes)["xl/worksheets/sheet1.xml"]!);
    expect(sheet.getElementsByTagName("pane")[0]?.getAttribute("state")).toBe("frozen");
    const last = columnName(COLUMNS.length - 1);
    expect(sheet.getElementsByTagName("autoFilter")[0]?.getAttribute("ref")).toBe(`A1:${last}3`);
    const widths = Array.from(sheet.getElementsByTagName("col")).map((col) => Number(col.getAttribute("width")));
    expect(widths).toEqual(COLUMNS.map((column) => column.width));
    // Wide enough for every heading, and the day columns for "10/26/2026".
    COLUMNS.forEach((column) => expect(column.width, column.heading).toBeGreaterThanOrEqual(column.heading.length));
    for (const heading of ["Date", "Due date", "Paid on", "Reviewed on"]) {
      expect(COLUMNS.find((column) => column.heading === heading)!.width, heading).toBeGreaterThanOrEqual(11);
    }
  });

  it("keeps a credit a number, and money in doubt as words", () => {
    const credit = item("1", {
      picked: { kind: "bill", amount: "-85.27", dueDate: null, paidDate: null, dueNow: false, needsCheck: false, values: { amount: ["-85.27"] } },
    });
    const doubtful = item("2", {
      picked: { kind: "bill", amount: null, dueDate: null, paidDate: null, dueNow: false, needsCheck: true, values: { amount: ["10.00", "12.00"] } },
    });
    const c = cells(capturesXlsx([credit, doubtful]));
    expect(c.get(ref("Amount", 2))).toEqual({ t: null, s: "2", value: "-85.27" });
    expect(c.get(ref("Amount", 3))).toEqual({ t: "inlineStr", s: null, value: "10.00 or 12.00" });
  });

  it("stores words from an email as text, never as a formula, and drops what XML cannot hold", () => {
    const sneaky = item("1", { subject: '=HYPERLINK("http://evil.example") <b>&</b>\u0000\u0008 ok', mailbox: " Spaced " });
    const bytes = capturesXlsx([sneaky]);
    const c = cells(bytes);
    expect(c.get(ref("Subject", 2))).toEqual({ t: "inlineStr", s: null, value: '=HYPERLINK("http://evil.example") <b>&</b> ok' });
    expect(parts(bytes)["xl/worksheets/sheet1.xml"]).not.toContain("<f>");
    // Spaces at either end kept.
    expect(c.get(ref("Mailbox", 2))?.value).toBe(" Spaced ");
  });

  it("writes just the heading row when there are no emails", () => {
    const c = cells(capturesXlsx([]));
    expect([...c.keys()].every((r) => /^[A-Z]+1$/.test(r))).toBe(true);
    expect(c.size).toBe(COLUMNS.length);
  });
});

describe("the helpers", () => {
  it("names columns the way Excel does", () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(columnName)).toEqual(["A", "B", "Z", "AA", "AB", "AZ", "BA", "ZZ", "AAA"]);
  });

  it("turns a day into Excel's day number, and refuses what is not a day", () => {
    expect(excelDay("2026-10-26")).toBe(46321);
    expect(excelDay("1900-03-01")).toBe(61);
    expect(excelDay("2026-02-30")).toBeNull();
    expect(excelDay("26-10-2026")).toBeNull();
    expect(excelDay("")).toBeNull();
  });

  it("escapes XML's specials and drops characters XML cannot hold", () => {
    expect(xmlText(`a & b < c > d " e`)).toBe("a &amp; b &lt; c &gt; d &quot; e");
    expect(xmlText("tab\tline\nok\u0001￾\uD800")).toBe("tab\tline\nok");
    expect(xmlText("Café 😀")).toBe("Café 😀");
  });
});
