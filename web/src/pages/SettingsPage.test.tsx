// @vitest-environment jsdom
// The Settings page and the mailbox pages against a stand-in server: what an
// admin and a member see, "Check mail now", saving the install's settings,
// changing your password, trying a mailbox's settings before saving, and
// restoring a removed mailbox.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MailboxInfo, MailboxListResponse, RemovedMailbox, SessionResponse, SettingsResponse } from "../../../src/shared/api";
import { EditMailboxPage, NewMailboxPage, RestoreMailboxPage } from "./MailboxEditPage";
import { SettingsPage } from "./SettingsPage";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const MAILBOX: MailboxInfo = {
  id: 4,
  name: "Proton bill label",
  slug: "proton-bill-label",
  provider: "proton-bridge",
  folders: ["Labels/Bill"],
  skipFolders: [],
  imap: { host: "host.docker.internal", port: 1144, security: "none", username: "bills@example.com", passwordSet: true, passwordProblem: null },
  enabled: true,
  lastCheck: { at: "2026-10-30T12:00:00Z", ok: true, message: "0 new, 36 captured before", captured: 0 },
  lastOkAt: "2026-10-30T12:00:00Z",
  failingSince: null,
  createdAt: "2026-10-30T00:00:00Z",
  updatedAt: "2026-10-30T00:00:00Z",
};

const SETTINGS: SettingsResponse = {
  configPath: "/app/config.yml",
  logLevel: "info",
  captureEveryMinutes: 15,
  web: { port: 8080 },
  docker: { network: "ourhome_net", port: 8080, bind: "127.0.0.1" },
  canEdit: true,
  needsRestart: [],
  ignoredMailboxes: 3,
  secretKey: "env",
};

function reply(status: number, body?: unknown): Response {
  return body === undefined ? new Response(null, { status }) : new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** A stand-in server; records what was sent. */
function stub(options: { admin?: boolean; running?: boolean; removed?: RemovedMailbox[] } = {}) {
  const admin = options.admin ?? true;
  const sent: Array<[string, string, unknown]> = [];
  const session: SessionResponse = {
    user: { id: 1, email: "sam@example.com", name: "Sam", isAdmin: admin, household: { id: 1, name: "The Smiths" } },
    setupNeeded: false,
  };
  const list: MailboxListResponse = {
    mailboxes: [MAILBOX],
    removed: options.removed ?? [],
    checking: { everyMinutes: 15, running: options.running ?? false, lastStartedAt: null, lastFinishedAt: null, nextAt: null },
    canEdit: admin,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      sent.push([method, path, body]);
      if (path === "/api/session") return reply(200, session);
      if (path === "/api/mailboxes" && method === "GET") return reply(200, list);
      if (path === "/api/mailboxes/check") {
        // As on the server: the read is running until it finishes.
        list.checking = { ...list.checking, running: true };
        return reply(200, list.checking);
      }
      if (path === "/api/settings" && method === "GET") return reply(200, { ...SETTINGS, canEdit: admin });
      if (path === "/api/settings" && method === "PUT") return reply(200, { ...SETTINGS, ...body });
      if (path === "/api/account/password") {
        return body.currentPassword === "right password" ? reply(204) : reply(400, { error: "Your current password is not right." });
      }
      if (path === "/api/mailboxes/test") {
        return reply(200, { ok: true, message: 'Signed in. The folder "Labels/Bill" has 36 messages.', folders: ["INBOX", "Labels/Bill", "Folders/Bills"] });
      }
      if (path.startsWith("/api/mailboxes") && (method === "PUT" || method === "POST")) return reply(200, { ...MAILBOX, ...body });
      return reply(404, { error: "There is nothing here." });
    }),
  );
  return sent;
}

function show(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/settings/mailboxes/new" element={<NewMailboxPage />} />
          <Route path="/settings/mailboxes/:id" element={<EditMailboxPage />} />
          <Route path="/settings/mailboxes/removed/:id" element={<RestoreMailboxPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const card = async (heading: string) => (await screen.findByRole("heading", { name: heading })).closest("section")!;

/** The folders listed below the Folders box, in order. */
const folderList = () =>
  screen.queryByRole("list", { name: "Folders to read" }) === null
    ? []
    : within(screen.getByRole("list", { name: "Folders to read" }))
        .getAllByRole("listitem")
        .map((item) => item.querySelector(".font-mono")!.textContent);

describe("the Settings page", () => {
  it("lists the mailboxes with how each last read went, and checks mail now", async () => {
    const sent = stub();
    show("/settings");
    const mailboxes = await card("Mailboxes");
    await within(mailboxes).findByRole("heading", { name: "Proton bill label" });
    expect(mailboxes.textContent).toContain("Mail is read every 15 minutes.");
    expect(mailboxes.textContent).toMatch(/Read .*: 0 new, 36 captured before/);
    expect(mailboxes.textContent).toContain("Proton Mail Bridge: bills@example.com at host.docker.internal:1144 (None)");
    expect(mailboxes.textContent).toContain("Saved");
    expect(within(mailboxes).getByRole("link", { name: "Edit Proton bill label" }).getAttribute("href")).toBe("/settings/mailboxes/4");
    expect(within(mailboxes).getByRole("link", { name: "Add a mailbox" })).toBeTruthy();

    fireEvent.click(within(mailboxes).getByRole("button", { name: "Check mail now" }));
    await waitFor(() => expect(sent).toContainEqual(["POST", "/api/mailboxes/check", undefined]));
    await waitFor(() => expect(mailboxes.textContent).toContain("Reading mail now."));
  });

  it("saves the install's settings, and says where the rest is changed", async () => {
    const sent = stub();
    show("/settings");
    const install = await card("This install");
    const minutes = await within(install).findByLabelText("Read mail every (minutes)");
    expect(install.textContent).toContain("config.yml still lists 3 mailboxes.");
    expect(install.textContent).toContain("Encrypted with the key in .env.");
    expect(install.textContent).toContain("network ourhome_net, port 8080, open to this computer only");

    fireEvent.change(minutes, { target: { value: "0" } });
    fireEvent.click(within(install).getByRole("button", { name: "Save" }));
    expect(install.textContent).toContain("Enter a whole number of minutes from 1 to 1440");
    expect(sent.some(([method, path]) => method === "PUT" && path === "/api/settings")).toBe(false);

    fireEvent.change(minutes, { target: { value: "5" } });
    fireEvent.click(within(install).getByRole("radio", { name: /^Everything/ }));
    fireEvent.click(within(install).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(sent).toContainEqual(["PUT", "/api/settings", { captureEveryMinutes: 5, logLevel: "debug" }]));
    expect(await within(install).findByText("Saved to config.yml and in use now.")).toBeTruthy();
  });

  it("shows a member the settings without ways to change them", async () => {
    stub({ admin: false });
    show("/settings");
    const mailboxes = await card("Mailboxes");
    await within(mailboxes).findByRole("heading", { name: "Proton bill label" });
    expect(within(mailboxes).queryByRole("link", { name: /Edit|Add a mailbox/ })).toBeNull();
    const install = await card("This install");
    await within(install).findByText("Every 15 minutes");
    expect(within(install).queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("changes your password, checking the new one is typed the same twice", async () => {
    const sent = stub();
    show("/settings");
    const account = await card("Your account");
    expect(account.textContent).toContain("sam@example.com");
    const field = (label: string) => within(account).getByLabelText(label);
    fireEvent.change(field("Current password"), { target: { value: "right password" } });
    fireEvent.change(field("New password"), { target: { value: "a brand new password" } });
    fireEvent.change(field("New password again"), { target: { value: "a brand new passwrod" } });
    fireEvent.click(within(account).getByRole("button", { name: "Change password" }));
    expect(account.textContent).toContain("The two new passwords are not the same.");
    fireEvent.change(field("New password again"), { target: { value: "a brand new password" } });
    fireEvent.click(within(account).getByRole("button", { name: "Change password" }));
    expect(await within(account).findByText(/^Password changed\./)).toBeTruthy();
    expect(sent).toContainEqual(["PUT", "/api/account/password", { currentPassword: "right password", newPassword: "a brand new password" }]);
    expect((field("Current password") as HTMLInputElement).value).toBe("");
  });
});

describe("a mailbox's page", () => {
  it("tries the settings with the saved password, offers the folders, and saves without sending a password", async () => {
    const sent = stub();
    show("/settings/mailboxes/4");
    const password = (await screen.findByLabelText("Password")) as HTMLInputElement;
    expect(password.value).toBe("");
    expect(screen.getByText("A password is saved. Leave this empty to keep it.")).toBeTruthy();

    // The mailbox's folders sit beside the box, waiting for a test to load them.
    const picker = screen.getByRole("combobox", { name: "Folders in this mailbox" }) as HTMLSelectElement;
    expect(picker.disabled).toBe(true);
    expect(within(picker).getByRole("option", { name: "Test connection to load folders" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText('Signed in. The folder "Labels/Bill" has 36 messages.')).toBeTruthy();
    const testCall = sent.find(([, path]) => path === "/api/mailboxes/test")!;
    expect(testCall[2]).toEqual({ id: 4, provider: "proton-bridge", host: "host.docker.internal", port: 1144, security: "none", username: "bills@example.com", folders: ["Labels/Bill"], skipFolders: [] });

    // A folder already read cannot be picked again; another is added to the list.
    expect(picker.disabled).toBe(false);
    expect((within(picker).getByRole("option", { name: "Labels/Bill" }) as HTMLOptionElement).disabled).toBe(true);
    fireEvent.change(picker, { target: { value: "Folders/Bills" } });
    expect(folderList()).toEqual(["Labels/Bill", "Folders/Bills"]);
    fireEvent.click(screen.getByRole("checkbox", { name: /Read this mailbox/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(sent).toContainEqual([
        "PUT",
        "/api/mailboxes/4",
        {
          name: "Proton bill label",
          provider: "proton-bridge",
          host: "host.docker.internal",
          port: 1144,
          security: "none",
          username: "bills@example.com",
          folders: ["Labels/Bill", "Folders/Bills"],
          skipFolders: [],
          enabled: false,
        },
      ]),
    );
  });

  it("adds a typed folder on Enter or on leaving the box, lists it below, and removes it", async () => {
    const sent = stub();
    show("/settings/mailboxes/4");
    const box = (await screen.findByLabelText("Folders")) as HTMLInputElement;
    expect(folderList()).toEqual(["Labels/Bill"]);

    // Typed as Proton shows it; listed as the Bridge's path, which is what is read.
    fireEvent.change(box, { target: { value: " Receipts " } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(folderList()).toEqual(["Labels/Bill", "Folders/Receipts"]);
    expect(box.value).toBe("");
    // Enter added the folder; it did not save the form.
    expect(sent.some(([method]) => method === "PUT")).toBe(false);

    fireEvent.change(box, { target: { value: "INBOX" } });
    fireEvent.blur(box);
    expect(folderList()).toEqual(["Labels/Bill", "Folders/Receipts", "INBOX"]);

    fireEvent.change(box, { target: { value: "INBOX" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(screen.getByText('"INBOX" is already in the list.')).toBeTruthy();
    expect(box.value).toBe("INBOX");
    fireEvent.change(box, { target: { value: "" } });

    fireEvent.click(screen.getByRole("button", { name: "Remove Labels/Bill" }));
    expect(folderList()).toEqual(["Folders/Receipts", "INBOX"]);
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(sent.find(([method]) => method === "PUT")?.[2]).toMatchObject({ folders: ["Folders/Receipts", "INBOX"] }));
  });

  it("adds a label to leave out below the folders, never one that is read, and sends it", async () => {
    const sent = stub();
    show("/settings/mailboxes/4");
    const box = (await screen.findByLabelText("Leave out emails also in")) as HTMLInputElement;
    fireEvent.change(box, { target: { value: "Labels/Bill" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(screen.getByText('"Labels/Bill" is read by this mailbox, so it cannot also be left out.')).toBeTruthy();
    fireEvent.change(box, { target: { value: "Labels/Skip" } });
    fireEvent.keyDown(box, { key: "Enter" });
    const skipList = within(screen.getByRole("list", { name: "Folders to leave out" }));
    expect(skipList.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Labels/Skip"]);
    expect(folderList()).toEqual(["Labels/Bill"]);
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(sent.find(([method]) => method === "PUT")?.[2]).toMatchObject({ folders: ["Labels/Bill"], skipFolders: ["Labels/Skip"] }));
  });

  it("needs at least one folder", async () => {
    const sent = stub();
    show("/settings/mailboxes/4");
    fireEvent.click(await screen.findByRole("button", { name: "Remove Labels/Bill" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(screen.getByText("Add a folder to read, like INBOX or Folders/Bills.")).toBeTruthy();
    expect(sent.some(([method]) => method === "PUT")).toBe(false);
  });

  it("needs a password to add a new mailbox", async () => {
    stub();
    show("/settings/mailboxes/new");
    fireEvent.click(await screen.findByRole("button", { name: "Add mailbox" }));
    expect(screen.getByText("Enter the IMAP password.")).toBeTruthy();
  });
});

const REMOVED: RemovedMailbox = {
  id: 9,
  name: "Old bills",
  slug: "old-bills",
  provider: "proton-bridge",
  folders: ["Labels/Bill"],
  skipFolders: [],
  imap: { host: "host.docker.internal", port: 1144, security: "none", username: "bills@example.com" },
  emails: 36,
  removedAt: "2026-10-31T02:33:00Z",
};

describe("a removed mailbox", () => {
  it("is listed in Settings with the emails it would bring back", async () => {
    stub({ removed: [REMOVED] });
    show("/settings");
    const removed = await card("Removed mailboxes");
    expect(removed.textContent).toContain("Old bills");
    expect(removed.textContent).toContain("36 emails kept, from Labels/Bill");
    expect(within(removed).getByRole("link", { name: "Restore Old bills" }).getAttribute("href")).toBe("/settings/mailboxes/removed/9");
  });

  it("is listed for a member too, without a way to restore it", async () => {
    stub({ admin: false, removed: [REMOVED] });
    show("/settings");
    const removed = await card("Removed mailboxes");
    expect(removed.textContent).toContain("Old bills");
    expect(within(removed).queryByRole("link")).toBeNull();
  });

  it("is restored with what was kept and the password typed again", async () => {
    const sent = stub({ removed: [REMOVED] });
    show("/settings/mailboxes/removed/9");
    expect(await screen.findByText(/36 emails come back when you restore it\. Its password was not kept: enter it again\./)).toBeTruthy();
    expect((screen.getByLabelText("IMAP server") as HTMLInputElement).value).toBe("host.docker.internal");
    expect(folderList()).toEqual(["Labels/Bill"]);
    fireEvent.click(screen.getByRole("button", { name: "Restore mailbox" }));
    expect(screen.getByText("Enter the IMAP password.")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "bridge password" } });
    fireEvent.click(screen.getByRole("button", { name: "Restore mailbox" }));
    await waitFor(() =>
      expect(sent).toContainEqual([
        "POST",
        "/api/mailboxes/9/restore",
        {
          name: "Old bills",
          provider: "proton-bridge",
          host: "host.docker.internal",
          port: 1144,
          security: "none",
          username: "bills@example.com",
          password: "bridge password",
          folders: ["Labels/Bill"],
          skipFolders: [],
          enabled: true,
        },
      ]),
    );
  });

  it("found on disk asks for its server and login too", async () => {
    stub({ removed: [{ ...REMOVED, imap: null }] });
    show("/settings/mailboxes/removed/9");
    expect(await screen.findByText(/its server and login are not known/)).toBeTruthy();
    expect((screen.getByLabelText("IMAP server") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Old bills");
  });

  it("that is not there shows not found", async () => {
    stub({ removed: [REMOVED] });
    show("/settings/mailboxes/removed/10");
    expect(await screen.findByRole("heading", { name: /not found|nothing here/i })).toBeTruthy();
  });
});
