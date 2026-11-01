// Export as an Excel workbook (.xlsx): one sheet, "Captured mail", with the
// columns in exportColumns.ts. Unlike a CSV it carries column widths, so days
// show at once instead of "#####"; the heading row is bold, stays in view
// while scrolling and has Excel's filter buttons.
//
// An .xlsx file is a zip of a few XML files (Office Open XML, ECMA-376). They
// are written here by hand, the smallest set Excel, LibreOffice and Google
// Sheets open, and zipped with fflate. Every cell has a type: words are
// stored as text (never read as a formula, so no guard is needed), money as
// a number shown with two decimals, days as dates shown in the reader's own
// short date format.

import { strToU8, zipSync } from "fflate";
import type { CaptureListItem } from "../../../src/shared/api";
import { COLUMNS, type ExportCell } from "./exportColumns";

export const SHEET_NAME = "Captured mail";

/** Excel's limit on one cell's text. */
const MAX_CELL_TEXT = 32_767;

/** Styles in styles.xml's cellXfs, by position. */
const STYLE = { heading: 1, money: 2, day: 3 } as const;

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "A" for 0, "Z" for 25, "AA" for 26. */
export function columnName(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

/** A day ("2026-10-26") as Excel's day number (46321): days since 1899-12-30. Null when it is not a real day. */
export function excelDay(value: string): number | null {
  const m = DAY.exec(value);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const time = Date.UTC(y, mo - 1, d);
  const back = new Date(time);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return time / 86_400_000 + 25_569;
}

/** Text made safe for XML: characters XML cannot hold dropped (an email can carry them), the five specials escaped. */
export function xmlText(value: string): string {
  return value
    .replace(/[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function textCell(ref: string, value: string, style?: number): string {
  if (value === "") return "";
  const kept = [...value].slice(0, MAX_CELL_TEXT).join("");
  const space = /^\s|\s$/.test(kept) ? ' xml:space="preserve"' : "";
  return `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ""}><is><t${space}>${xmlText(kept)}</t></is></c>`;
}

function cellXml(ref: string, cell: ExportCell): string {
  if (cell.kind === "money") {
    const amount = Number(cell.value);
    if (cell.value.trim() !== "" && Number.isFinite(amount)) return `<c r="${ref}" s="${STYLE.money}"><v>${amount}</v></c>`;
  } else if (cell.kind === "day") {
    const serial = excelDay(cell.value);
    if (serial !== null) return `<c r="${ref}" s="${STYLE.day}"><v>${serial}</v></c>`;
  }
  return textCell(ref, cell.value);
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";

function sheetXml(items: readonly CaptureListItem[]): string {
  const last = columnName(COLUMNS.length - 1);
  const cols = COLUMNS.map((column, i) => `<col min="${i + 1}" max="${i + 1}" width="${column.width}" customWidth="1"/>`).join("");
  const rows = [
    `<row r="1">${COLUMNS.map((column, i) => textCell(`${columnName(i)}1`, column.heading, STYLE.heading)).join("")}</row>`,
    ...items.map((item, r) => {
      const row = r + 2;
      return `<row r="${row}">${COLUMNS.map((column, i) => cellXml(`${columnName(i)}${row}`, column.cell(item))).join("")}</row>`;
    }),
  ];
  return (
    XML_HEAD +
    `<worksheet xmlns="${MAIN}" xmlns:r="${REL}">` +
    `<dimension ref="A1:${last}${items.length + 1}"/>` +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    `<cols>${cols}</cols>` +
    `<sheetData>${rows.join("")}</sheetData>` +
    `<autoFilter ref="A1:${last}${items.length + 1}"/>` +
    "</worksheet>"
  );
}

function workbookXml(rowCount: number): string {
  const last = columnName(COLUMNS.length - 1);
  return (
    XML_HEAD +
    `<workbook xmlns="${MAIN}" xmlns:r="${REL}">` +
    `<sheets><sheet name="${SHEET_NAME}" sheetId="1" r:id="rId1"/></sheets>` +
    // Excel keeps the filter's range here as well as on the sheet.
    `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${SHEET_NAME}'!$A$1:$${last}$${rowCount}</definedName></definedNames>` +
    "</workbook>"
  );
}

// Fonts: 0 normal, 1 bold. cellXfs: 0 normal, 1 heading (bold), 2 money ("0.00", built-in 2), 3 day (the reader's short date, built-in 14).
const STYLES_XML =
  XML_HEAD +
  `<styleSheet xmlns="${MAIN}">` +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="4">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  "</cellXfs>" +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  "</styleSheet>";

const CONTENT_TYPES_XML =
  XML_HEAD +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
  "</Types>";

const ROOT_RELS_XML =
  XML_HEAD +
  `<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

const WORKBOOK_RELS_XML =
  XML_HEAD +
  `<Relationships xmlns="${PKG_REL}">` +
  `<Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/>` +
  `<Relationship Id="rId2" Type="${REL}/styles" Target="styles.xml"/>` +
  "</Relationships>";

/** The workbook for these emails, in this order, as the bytes of an .xlsx file. */
export function capturesXlsx(items: readonly CaptureListItem[]): Uint8Array {
  return zipSync(
    {
      "[Content_Types].xml": strToU8(CONTENT_TYPES_XML),
      "_rels/.rels": strToU8(ROOT_RELS_XML),
      "xl/workbook.xml": strToU8(workbookXml(items.length + 1)),
      "xl/_rels/workbook.xml.rels": strToU8(WORKBOOK_RELS_XML),
      "xl/styles.xml": strToU8(STYLES_XML),
      "xl/worksheets/sheet1.xml": strToU8(sheetXml(items)),
    },
    { level: 6 },
  );
}
