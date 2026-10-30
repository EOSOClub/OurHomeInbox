// Small display helpers: dates, sizes, senders, subjects and fingerprints,
// written once so every page shows them the same way.

import type { CapturedAddress } from "../../src/shared/capture";

export interface DateOptions {
  /** Defaults to the browser's language. */
  locale?: string;
  /** Defaults to the browser's time zone. */
  timeZone?: string;
}

function parseDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Full date and time, for example "Oct 29, 2026, 3:04 PM". */
export function formatDateTime(iso: string | null | undefined, options: DateOptions = {}): string {
  const date = parseDate(iso);
  if (!date) return iso ? iso : "Unknown";
  return new Intl.DateTimeFormat(options.locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: options.timeZone,
  }).format(date);
}

function dayKey(date: Date, timeZone: string | undefined): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

/** Short date for a list row: the time for today, "Oct 3" this year, "Oct 3, 2025" before that. */
export function formatListDate(iso: string | null | undefined, now: Date = new Date(), options: DateOptions = {}): string {
  const date = parseDate(iso);
  if (!date) return iso ? iso : "Unknown";
  const { locale, timeZone } = options;
  const day = dayKey(date, timeZone);
  const today = dayKey(now, timeZone);
  if (day === today) {
    return new Intl.DateTimeFormat(locale, { timeStyle: "short", timeZone }).format(date);
  }
  if (day.slice(0, 4) === today.slice(0, 4)) {
    return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", timeZone }).format(date);
  }
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone }).format(date);
}

const SIZE_UNITS = ["KB", "MB", "GB", "TB"] as const;

/** Human readable size: "1 byte", "512 bytes", "1.5 KB", "12 MB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "Unknown size";
  if (bytes === 1) return "1 byte";
  if (bytes < 1024) return `${Math.round(bytes)} bytes`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  let shown = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  if (shown >= 1024 && unit < SIZE_UNITS.length - 1) {
    shown = 1;
    unit += 1;
  }
  return `${shown} ${SIZE_UNITS[unit]}`;
}

/** The sender as a person would say it: their name, else their address. */
export function senderDisplay(from: CapturedAddress[]): string {
  const first = from[0];
  const label = first ? first.name.trim() || first.address.trim() : "";
  if (!label) return "(unknown sender)";
  return from.length > 1 ? `${label} and ${from.length - 1} more` : label;
}

/** "Name <address>", or just whichever of the two is there. */
export function formatAddress(address: CapturedAddress): string {
  const name = address.name.trim();
  const email = address.address.trim();
  if (name && email) return `${name} <${email}>`;
  return name || email || "(unknown)";
}

export function formatAddressList(list: CapturedAddress[]): string {
  return list.map(formatAddress).join(", ");
}

export function subjectDisplay(subject: string | null | undefined): string {
  return subject && subject.trim() ? subject : "(no subject)";
}

/** The first characters of a SHA-256 fingerprint, enough to tell files apart at a glance. */
export function shortHash(sha256: string, length = 12): string {
  return sha256.slice(0, length);
}

export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}
