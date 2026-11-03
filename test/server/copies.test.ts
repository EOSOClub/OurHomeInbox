// The same email captured more than once (copies.ts): only its original is used.

import { describe, expect, it } from "vitest";
import { copyReason, findCopies, type CopyCandidate } from "../../src/server/copies.js";

function email(id: string, messageId: string | null, more: Partial<CopyCandidate> = {}): CopyCandidate {
  return { id, messageId, offered: null, capturedAt: "2026-11-02T12:00:00.000Z", ...more };
}

describe("findCopies", () => {
  it("makes every email with the same Message-ID but the first captured a copy of it", () => {
    const copies = findCopies([
      email("proton-bill-label/1/9", "<bill-1@wm.com>", { capturedAt: "2026-11-02T12:05:00.000Z" }),
      email("proton-bills/1/4", "<bill-1@wm.com>", { capturedAt: "2026-11-02T12:00:00.000Z" }),
      email("proton-bills/1/5", "<bill-2@wm.com>"),
    ]);
    expect(copies).toEqual(new Map([["proton-bill-label/1/9", "proton-bills/1/4"]]));
  });

  it("keeps the one already offered to OurHome as the original, the lowest offer number first", () => {
    const copies = findCopies([
      email("a", "<x@wm.com>", { capturedAt: "2026-11-01T00:00:00.000Z" }),
      email("b", "<x@wm.com>", { offered: 7 }),
      email("c", "<x@wm.com>", { offered: 3, capturedAt: "2026-11-03T00:00:00.000Z" }),
    ]);
    expect(copies).toEqual(
      new Map([
        ["a", "c"],
        ["b", "c"],
      ]),
    );
  });

  it("breaks a tie on the capture id, and compares Message-IDs without their brackets or spaces", () => {
    expect(findCopies([email("b", "<x@wm.com>"), email("a", " x@wm.com ")])).toEqual(new Map([["b", "a"]]));
  });

  it("never makes an email with no Message-ID a copy", () => {
    expect(findCopies([email("a", null), email("b", null), email("c", ""), email("d", "<>")]).size).toBe(0);
  });

  it("tells a copy's reason with its original's mailbox", () => {
    expect(copyReason("Proton bills")).toBe("A copy of an email also captured from the Proton bills mailbox: only that one is used.");
  });
});
