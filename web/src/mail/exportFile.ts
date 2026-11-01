// Export: the emails the list shows (or the ones selected) saved as a file,
// as CSV (the default), an Excel workbook or JSON. Built in the browser from
// the list the page already has, so the file holds exactly the rows on screen.
// The files themselves are made in exportCsv.ts, exportXlsx.ts and
// exportJson.ts.

import type { CaptureListItem } from "../../../src/shared/api";
import { localDay } from "./captureList";
import { capturesCsv } from "./exportCsv";
import { capturesJson } from "./exportJson";
import { capturesXlsx } from "./exportXlsx";

export const EXPORT_FORMATS = ["csv", "xlsx", "json"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const EXPORT_FORMAT_LABELS: Record<ExportFormat, string> = {
  csv: "CSV",
  xlsx: "Excel (.xlsx)",
  json: "JSON",
};

/** "ourhome-inbox-2026-11-01.csv", today in the browser's time zone. */
export function exportFileName(format: ExportFormat, now: Date = new Date()): string {
  return `ourhome-inbox-${localDay(now.toISOString())}.${format}`;
}

/** The file's contents and type. The CSV starts with a byte order mark so Excel reads accents and other letters correctly. */
export function exportContent(items: readonly CaptureListItem[], format: ExportFormat, now: Date = new Date()): { parts: BlobPart[]; type: string } {
  switch (format) {
    case "csv":
      return { parts: ["﻿", capturesCsv(items)], type: "text/csv;charset=utf-8" };
    case "xlsx":
      return { parts: [capturesXlsx(items) as Uint8Array<ArrayBuffer>], type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
    case "json":
      return { parts: [capturesJson(items, now)], type: "application/json" };
  }
}

/** Saves the emails through the browser's download; returns the file's name. */
export function downloadExport(items: readonly CaptureListItem[], format: ExportFormat, now: Date = new Date()): string {
  const name = exportFileName(format, now);
  const { parts, type } = exportContent(items, format, now);
  const url = URL.createObjectURL(new Blob(parts, { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.style.display = "none";
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    // After the click has handed the file to the browser.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  return name;
}
