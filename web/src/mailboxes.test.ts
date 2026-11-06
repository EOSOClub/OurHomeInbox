// The mailbox form's checks and how a mailbox's state is put in words.

import { describe, expect, it } from "vitest";
import type { MailboxInfo } from "../../src/shared/api";
import { addFolder, checkConnection, checkingLine, checkMailboxForm, EMPTY_MAILBOX_FORM, formFromMailbox, lastCheckLine, type MailboxForm } from "./mailboxes";

const good: MailboxForm = {
  ...EMPTY_MAILBOX_FORM,
  name: " Sam's Proton ",
  host: " host.docker.internal ",
  port: " 1144 ",
  security: "none",
  username: " bills@example.com ",
  password: " pass with spaces ",
  folders: ["Folders/Bills"],
};

const saved: MailboxInfo = {
  id: 4,
  name: "Bills",
  slug: "bills",
  provider: "proton-bridge",
  folders: ["Labels/Bill"],
  skipFolders: ["Labels/Skip"],
  imap: { host: "protonmail-bridge", port: 143, security: "none", username: "u@example.com", passwordSet: true, passwordProblem: null },
  enabled: true,
  lastCheck: null,
  lastOkAt: null,
  failingSince: null,
  createdAt: "2026-10-30T00:00:00Z",
  updatedAt: "2026-10-30T00:00:00Z",
};

describe("checkMailboxForm", () => {
  it("turns a good form into the request, trimmed except for the password", () => {
    expect(checkMailboxForm(good, null)).toEqual({
      errors: {},
      input: {
        name: "Sam's Proton",
        provider: "proton-bridge",
        host: "host.docker.internal",
        port: 1144,
        security: "none",
        username: "bills@example.com",
        password: " pass with spaces ",
        folders: ["Folders/Bills"],
        skipFolders: [],
        enabled: true,
      },
    });
  });

  it("asks for every field of a new mailbox", () => {
    expect(checkMailboxForm(EMPTY_MAILBOX_FORM, null)).toEqual({
      errors: {
        name: "Enter a name for the mailbox.",
        host: "Enter the IMAP server's address.",
        port: "Enter the IMAP port, like 1143.",
        security: "Choose how the connection is protected.",
        username: "Enter the IMAP username.",
        password: "Enter the IMAP password.",
        folders: "Add a folder to read, like INBOX or Folders/Bills.",
      },
      input: null,
    });
  });

  it("keeps a saved password when none is typed: it is left out of the request", () => {
    const { input } = checkMailboxForm(formFromMailbox(saved), saved);
    expect(input).not.toHaveProperty("password");
    expect(input).toMatchObject({ name: "Bills", port: 143, folders: ["Labels/Bill"] });
  });

  it("counts a folder still in the box, trimmed, so saving before Enter does not lose it", () => {
    expect(checkMailboxForm({ ...good, folderDraft: " INBOX " }, null).input?.folders).toEqual(["Folders/Bills", "INBOX"]);
    expect(checkMailboxForm({ ...good, folders: [], folderDraft: "INBOX" }, null).input?.folders).toEqual(["INBOX"]);
    expect(checkMailboxForm({ ...good, folderDraft: "Folders/Bills" }, null).errors.folders).toBe('"Folders/Bills" is already in the list.');
  });

  it.each([
    [{ port: "70000" }, "port", "between 1 and 65535"],
    [{ port: "1.5" }, "port", "whole number"],
    [{ host: "http://x/y" }, "host", "no spaces or slashes"],
    [{ name: "!!!" }, "name", "at least one letter or number"],
  ])("refuses %j", (change, field, message) => {
    const { errors, input } = checkMailboxForm({ ...good, ...change }, null);
    expect(input).toBeNull();
    expect(errors[field as keyof MailboxForm]).toContain(message);
  });
});

describe("addFolder", () => {
  it("adds the typed folder, trimmed, and empties the box", () => {
    expect(addFolder({ ...good, folderDraft: "  Labels/Bill " })).toEqual({ form: { ...good, folders: ["Folders/Bills", "Labels/Bill"], folderDraft: "" }, error: null });
  });

  it("adds a Proton folder typed as Proton shows it as the Bridge's path, and sees it is already listed", () => {
    expect(addFolder({ ...good, folderDraft: "Finance/Receipts" }).form.folders).toEqual(["Folders/Bills", "Folders/Finance/Receipts"]);
    expect(addFolder({ ...good, folderDraft: "Bills" }).error).toBe('"Folders/Bills" is already in the list.');
  });

  it("does nothing for an empty box", () => {
    expect(addFolder({ ...good, folderDraft: "   " })).toEqual({ form: { ...good, folderDraft: "" }, error: null });
  });

  it.each([
    ["Folders/Bills", '"Folders/Bills" is already in the list.'],
    ["x".repeat(301), "That folder name is too long."],
  ])("keeps %s in the box and says why it cannot be added", (folderDraft, error) => {
    const form = { ...good, folderDraft };
    expect(addFolder(form)).toEqual({ form, error });
  });

  it("adds a folder to leave out the same way, and never lets one folder be in both lists", () => {
    const left = addFolder({ ...good, skipDraft: " labels/skip " }, "skipFolders");
    expect(left).toEqual({ form: { ...good, skipFolders: ["Labels/skip"], skipDraft: "" }, error: null });
    expect(addFolder({ ...good, skipDraft: "Bills" }, "skipFolders").error).toBe('"Folders/Bills" is read by this mailbox, so it cannot also be left out.');
    expect(addFolder({ ...left.form, folderDraft: "Labels/skip" }).error).toBe('"Labels/skip" is left out, so it cannot also be read.');
  });

  it("keeps the saved folders to leave out, and counts one still in its box", () => {
    expect(checkMailboxForm(formFromMailbox(saved), saved).input?.skipFolders).toEqual(["Labels/Skip"]);
    expect(checkMailboxForm({ ...good, skipDraft: "Labels/Skip" }, null).input?.skipFolders).toEqual(["Labels/Skip"]);
    expect(checkMailboxForm({ ...good, skipDraft: "Folders/Bills" }, null).errors.skipFolders).toBe(
      '"Folders/Bills" is read by this mailbox, so it cannot also be left out.',
    );
  });

  it("stops at 20 folders", () => {
    const full = { ...good, folders: Array.from({ length: 20 }, (_, i) => `F${i}`), folderDraft: "One more" };
    expect(addFolder(full).error).toBe("A mailbox can read up to 20 folders.");
  });
});

describe("checkConnection", () => {
  it("does not need a name to try the settings", () => {
    expect(checkConnection({ ...good, name: "" }, null).connection).toMatchObject({ host: "host.docker.internal", port: 1144 });
  });

  it("asks for the password again when the server or login changed, as the server does", () => {
    const form = formFromMailbox(saved);
    for (const change of [{ host: "attacker.example" }, { port: "993" }, { security: "tls" as const }, { username: "other@example.com" }]) {
      const { errors, connection } = checkConnection({ ...form, ...change }, saved);
      expect(connection, JSON.stringify(change)).toBeNull();
      expect(errors.password).toMatch(/^Enter the password again: the server, port, security or username changed/);
    }
    expect(checkConnection({ ...form, host: "ProtonMail-Bridge" }, saved).connection).not.toBeNull();
    expect(checkConnection({ ...form, host: "attacker.example", password: "typed" }, saved).connection).toMatchObject({ password: "typed" });
  });
});

describe("the words", () => {
  it("says how the last read went", () => {
    expect(lastCheckLine(saved)).toBe("Not read yet.");
    expect(lastCheckLine({ ...saved, enabled: false })).toBe("Paused: not read until it is turned back on.");
    const failed = { ...saved, lastCheck: { at: "2026-10-30T12:00:00Z", ok: false, message: "127.0.0.1:1144 refused the connection. Check the port.", captured: 0 } };
    expect(lastCheckLine(failed)).toMatch(/^Problem .*: 127\.0\.0\.1:1144 refused the connection\. Check the port\.$/);
  });

  it("says when mail is read", () => {
    const state = { everyMinutes: 15, running: false, lastStartedAt: null, lastFinishedAt: null, nextAt: null };
    expect(checkingLine(state)).toBe("Mail is read every 15 minutes.");
    expect(checkingLine({ ...state, everyMinutes: 1, running: true })).toBe("Reading mail now. Mail is read every minute.");
    expect(checkingLine({ ...state, nextAt: "2026-10-30T12:15:00Z" })).toMatch(/^Mail is read every 15 minutes\. Next read: .+\.$/);
  });
});
