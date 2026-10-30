// Tests for the display helpers: sizes, dates, senders, subjects, hashes.

import { describe, expect, it } from "vitest";
import {
  formatAddress,
  formatAddressList,
  formatBytes,
  formatDateTime,
  formatListDate,
  plural,
  senderDisplay,
  shortHash,
  subjectDisplay,
} from "./format";

const US_UTC = { locale: "en-US", timeZone: "UTC" };
const spaces = (s: string) => s.replace(/\s/g, " ");

describe("formatBytes", () => {
  it("says bytes for small sizes", () => {
    expect(formatBytes(0)).toBe("0 bytes");
    expect(formatBytes(1)).toBe("1 byte");
    expect(formatBytes(1023)).toBe("1023 bytes");
  });

  it("uses one decimal under 10 and whole numbers above", () => {
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(20 * 1024)).toBe("20 KB");
    expect(formatBytes(5.25 * 1024 * 1024)).toBe("5.3 MB");
    expect(formatBytes(3 * 1024 ** 3)).toBe("3 GB");
  });

  it("moves to the next unit instead of showing 1024", () => {
    expect(formatBytes(1024 * 1024 - 1)).toBe("1 MB");
  });

  it("handles impossible sizes", () => {
    expect(formatBytes(-1)).toBe("Unknown size");
    expect(formatBytes(Number.NaN)).toBe("Unknown size");
  });
});

describe("dates", () => {
  it("formats a full date and time", () => {
    expect(spaces(formatDateTime("2026-10-29T15:04:00Z", US_UTC))).toBe("Oct 29, 2026, 3:04 PM");
  });

  it("shows unknown or unreadable dates plainly", () => {
    expect(formatDateTime(null)).toBe("Unknown");
    expect(formatDateTime("not a date")).toBe("not a date");
  });

  it("shortens list dates by how recent they are", () => {
    const now = new Date("2026-10-29T20:00:00Z");
    expect(spaces(formatListDate("2026-10-29T15:04:00Z", now, US_UTC))).toBe("3:04 PM");
    expect(formatListDate("2026-03-02T15:04:00Z", now, US_UTC)).toBe("Mar 2");
    expect(formatListDate("2025-12-31T15:04:00Z", now, US_UTC)).toBe("Dec 31, 2025");
  });

  it("decides today in the given time zone", () => {
    const now = new Date("2026-10-29T03:00:00Z"); // Oct 28 evening in Chicago
    expect(formatListDate("2026-10-28T23:00:00Z", now, { locale: "en-US", timeZone: "America/Chicago" })).toMatch(/PM/);
    expect(formatListDate("2026-10-28T23:00:00Z", now, US_UTC)).toBe("Oct 28");
  });
});

describe("senders and addresses", () => {
  it("prefers the name, then the address", () => {
    expect(senderDisplay([{ name: "City Water", address: "bills@water.example" }])).toBe("City Water");
    expect(senderDisplay([{ name: "  ", address: "bills@water.example" }])).toBe("bills@water.example");
    expect(senderDisplay([])).toBe("(unknown sender)");
  });

  it("mentions extra senders", () => {
    const from = [
      { name: "A", address: "a@x.example" },
      { name: "B", address: "b@x.example" },
    ];
    expect(senderDisplay(from)).toBe("A and 1 more");
  });

  it("formats address lists", () => {
    expect(formatAddress({ name: "Sam", address: "sam@x.example" })).toBe("Sam <sam@x.example>");
    expect(formatAddress({ name: "", address: "sam@x.example" })).toBe("sam@x.example");
    expect(
      formatAddressList([
        { name: "Sam", address: "sam@x.example" },
        { name: "", address: "kim@x.example" },
      ]),
    ).toBe("Sam <sam@x.example>, kim@x.example");
  });
});

describe("other helpers", () => {
  it("fills in a missing subject", () => {
    expect(subjectDisplay(null)).toBe("(no subject)");
    expect(subjectDisplay("   ")).toBe("(no subject)");
    expect(subjectDisplay("Your bill")).toBe("Your bill");
  });

  it("shortens hashes and counts things", () => {
    expect(shortHash("0123456789abcdef0123")).toBe("0123456789ab");
    expect(plural(1, "link", "links")).toBe("1 link");
    expect(plural(3, "link", "links")).toBe("3 links");
  });
});
