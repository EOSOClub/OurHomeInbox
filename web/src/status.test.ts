// What the Status page raises, and what it only counts.

import { describe, expect, it } from "vitest";
import type { CaptureListItem, CheckingState, MailboxInfo } from "../../src/shared/api";
import { anyMailboxProblem, attention, emailCounts, mailboxProblem, mailboxState, readingProblem } from "./status";

const working: MailboxInfo = {
  id: 1,
  name: "Bills",
  slug: "bills",
  provider: "proton-bridge",
  folder: "Labels/Bill",
  imap: { host: "h", port: 1144, security: "none", username: "u", passwordSet: true, passwordProblem: null },
  enabled: true,
  lastCheck: { at: "2026-10-30T12:00:00Z", ok: true, message: "0 new, 36 captured before", captured: 0 },
  lastOkAt: "2026-10-30T12:00:00Z",
  failingSince: null,
  createdAt: "2026-10-30T00:00:00Z",
  updatedAt: "2026-10-30T00:00:00Z",
};
const failing: MailboxInfo = {
  ...working,
  name: "Shawn's",
  lastCheck: { at: "2026-10-30T12:00:00Z", ok: false, message: "host.docker.internal:1144 refused the connection. Check the port.", captured: 0 },
  failingSince: "2026-10-30T09:00:00Z",
};
const checking: CheckingState = { everyMinutes: 15, running: false, lastStartedAt: null, lastFinishedAt: "2026-10-30T12:00:00Z", nextAt: null };

describe("what needs someone", () => {
  it("raises a failing mailbox, with since when, and one with no usable password", () => {
    expect(mailboxProblem(working)).toBeNull();
    expect(mailboxProblem(failing)).toMatch(/^Shawn's has not been read since .+: host\.docker\.internal:1144 refused the connection\. Check the port\.$/);
    expect(mailboxProblem({ ...working, imap: { ...working.imap, passwordSet: false } })).toBe("Bills has no saved password, so it cannot be read. Add it in Settings.");
    expect(mailboxProblem({ ...working, imap: { ...working.imap, passwordSet: false, passwordProblem: "The saved password can no longer be read." } })).toBe(
      "Bills: The saved password can no longer be read.",
    );
  });

  it("does not raise a paused mailbox, or one not read yet", () => {
    expect(mailboxProblem({ ...failing, enabled: false })).toBeNull();
    expect(mailboxProblem({ ...working, lastCheck: null })).toBeNull();
    expect(mailboxState({ ...failing, enabled: false })).toEqual({ label: "Paused", tone: "quiet" });
    expect(mailboxState({ ...working, lastCheck: null })).toEqual({ label: "Not read yet", tone: "quiet" });
    expect(mailboxState(failing)).toEqual({ label: "Needs you", tone: "warn" });
    expect(mailboxState(working)).toEqual({ label: "Working", tone: "ok" });
  });

  it("raises reading that stopped: nothing finished for three intervals and none running", () => {
    expect(readingProblem(checking, new Date("2026-10-30T12:44:00Z"))).toBeNull();
    expect(readingProblem(checking, new Date("2026-10-30T12:46:00Z"))).toMatch(/^Mail has not been read since .+, though it should be every 15 minutes\.$/);
    expect(readingProblem({ ...checking, running: true }, new Date("2026-10-30T18:00:00Z"))).toBeNull();
  });

  it("lists it all, reading first", () => {
    const now = new Date("2026-10-30T13:00:00Z");
    expect(attention([working], checking, new Date("2026-10-30T12:10:00Z"))).toEqual([]);
    expect(attention([working, failing], checking, now)).toHaveLength(2);
    expect(attention([working, failing], checking, now)[0]).toMatch(/^Mail has not been read/);
    expect(anyMailboxProblem([working])).toBe(false);
    expect(anyMailboxProblem([working, failing])).toBe(true);
  });
});

describe("emailCounts", () => {
  it("counts bills and what may need a look", () => {
    const base = {
      senderVerified: true,
      biller: { id: 1, name: "WM", kind: "bill", matchedOn: "wm.com" },
      picked: { kind: "bill", amount: "60.00", dueDate: null, paidDate: null, dueNow: false, needsCheck: false },
      review: null,
    } as unknown as CaptureListItem;
    const list = [
      base,
      { ...base, picked: { ...base.picked, dueNow: true } },
      { ...base, picked: { ...base.picked, kind: "receipt", needsCheck: true } },
      { ...base, senderVerified: false, biller: null },
    ] as CaptureListItem[];
    expect(emailCounts(list)).toEqual({ total: 4, bills: 3, toReview: 4, notBill: 0, needsCheck: 1, pastDue: 1, senderNotVerified: 1, noBiller: 1 });
  });

  it("counts what is still to review, and drops a reviewed email from Need a check", () => {
    const base = {
      senderVerified: true,
      biller: null,
      picked: { kind: "bill", amount: null, dueDate: null, paidDate: null, dueNow: false, needsCheck: true },
      review: null,
    } as unknown as CaptureListItem;
    const list = [
      base,
      { ...base, review: { state: "checked", by: "Sam", at: "2026-10-30T12:00:00Z" } },
      { ...base, review: { state: "not-bill", by: null, at: "2026-10-30T12:00:00Z" } },
    ] as CaptureListItem[];
    expect(emailCounts(list)).toMatchObject({ total: 3, toReview: 1, notBill: 1, needsCheck: 1 });
  });
});
