// @vitest-environment jsdom
// Settings' Users section against a stand-in server that remembers users:
// what an admin and a member see, adding a user, changing one, a new
// password, removing one, and the server's refusals shown in plain words.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HouseholdUser, UserListResponse } from "../../../src/shared/api";
import { UsersCard } from "./UsersCard";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function reply(status: number, body?: unknown): Response {
  return body === undefined ? new Response(null, { status }) : new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const SAM: HouseholdUser = { id: 1, name: "Sam Smith", email: "sam@example.com", isAdmin: true, createdAt: "2026-10-29T12:00:00Z", you: true };
const KIM: HouseholdUser = { id: 2, name: "Kim Smith", email: "kim@example.com", isAdmin: false, createdAt: "2026-10-30T12:00:00Z", you: false };

/** A stand-in server holding the household's users; records what was sent. */
function stub(options: { admin?: boolean; users?: HouseholdUser[] } = {}) {
  const canManage = options.admin ?? true;
  let users = (options.users ?? [SAM, KIM]).map((u) => ({ ...u }));
  let nextId = 10;
  const sent: Array<[string, string, unknown]> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      sent.push([method, path, body]);
      if (path === "/api/session") return reply(200, { user: null, setupNeeded: false });
      if (path === "/api/users" && method === "GET") {
        const list: UserListResponse = { users: [...users].sort((a, b) => a.name.localeCompare(b.name)), canManage };
        return reply(200, list);
      }
      if (path === "/api/users" && method === "POST") {
        if (users.some((u) => u.email.toLowerCase() === body.email.toLowerCase())) return reply(409, { error: "That email address already has an account." });
        const user: HouseholdUser = { id: nextId++, name: body.name, email: body.email, isAdmin: body.isAdmin, createdAt: "2026-11-01T12:00:00Z", you: false };
        users.push(user);
        return reply(201, user);
      }
      const m = /^\/api\/users\/(\d+)(\/password)?$/.exec(path);
      const user = m ? users.find((u) => u.id === Number(m[1])) : undefined;
      if (m && !user) return reply(404, { error: "That person was not found. They may have been removed." });
      if (user && m?.[2] && method === "PUT") return reply(204);
      if (user && method === "PUT") {
        if (user.isAdmin && !body.isAdmin && users.filter((u) => u.isAdmin).length <= 1) {
          return reply(409, { error: "The household needs at least one admin. Make someone else an admin first." });
        }
        Object.assign(user, body);
        return reply(200, user);
      }
      if (user && method === "DELETE") {
        users = users.filter((u) => u !== user);
        return reply(204);
      }
      return reply(404, { error: "There is nothing here." });
    }),
  );
  return sent;
}

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <UsersCard />
    </QueryClientProvider>,
  );
}

/** The row of the user with this name. */
const row = async (name: string) => (await screen.findByText(name, { selector: "p > *, p" })).closest("li")!;
const rowNames = () => within(screen.getByRole("list")).getAllByRole("listitem").map((li) => li.querySelector("p")!.firstChild!.textContent);

describe("the Users section", () => {
  it("lists everyone with their email and who is an admin", async () => {
    stub();
    show();
    const sam = await row("Sam Smith");
    expect(sam.textContent).toContain("(you)");
    expect(sam.textContent).toContain("Admin");
    expect(sam.textContent).toContain("sam@example.com");
    const kim = await row("Kim Smith");
    expect(kim.textContent).not.toContain("Admin");
    expect(rowNames()).toEqual(["Kim Smith", "Sam Smith"]);
    expect(screen.getByText(/Everyone here can see and change everything/)).toBeTruthy();
  });

  it("gives an admin no New password or Remove on their own row", async () => {
    stub();
    show();
    const sam = await row("Sam Smith");
    expect(within(sam).getByRole("button", { name: "Edit Sam Smith" })).toBeTruthy();
    expect(within(sam).queryByRole("button", { name: /New password/ })).toBeNull();
    expect(within(sam).queryByRole("button", { name: /Remove/ })).toBeNull();
    const kim = await row("Kim Smith");
    expect(within(kim).getByRole("button", { name: "New password for Kim Smith" })).toBeTruthy();
    expect(within(kim).getByRole("button", { name: "Remove Kim Smith" })).toBeTruthy();
  });

  it("shows a member everyone, without any way to change them", async () => {
    stub({ admin: false });
    show();
    await row("Kim Smith");
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/An admin adds, changes and removes users/)).toBeTruthy();
  });

  it("adds a user, checking the form first, and says how they sign in", async () => {
    const sent = stub();
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Add a user" }));
    const form = screen.getByRole("form", { name: "Add a user" });
    fireEvent.click(within(form).getByRole("button", { name: "Add user" }));
    expect(within(form).getByText("Enter their name.")).toBeTruthy();
    expect(within(form).getByText("Enter a valid email address, like name@example.com.")).toBeTruthy();
    expect(within(form).getByText("Choose a password of at least 10 characters.")).toBeTruthy();
    expect(sent.some(([method]) => method === "POST")).toBe(false);

    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: " Lee Smith " } });
    fireEvent.change(within(form).getByLabelText("Email"), { target: { value: "lee@example.com" } });
    fireEvent.change(within(form).getByLabelText("First password"), { target: { value: "lees password 1" } });
    fireEvent.click(within(form).getByRole("checkbox", { name: /Admin/ }));
    fireEvent.click(within(form).getByRole("button", { name: "Add user" }));

    await screen.findByText(/Added Lee Smith\. Tell them to sign in with lee@example\.com/);
    expect(sent.find(([method]) => method === "POST")?.[2]).toEqual({ name: "Lee Smith", email: "lee@example.com", password: "lees password 1", isAdmin: true });
    expect(screen.queryByRole("form", { name: "Add a user" })).toBeNull();
    await waitFor(() => expect(rowNames()).toEqual(["Kim Smith", "Lee Smith", "Sam Smith"]));
  });

  it("shows the server's reason when an email is taken", async () => {
    stub();
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Add a user" }));
    const form = screen.getByRole("form", { name: "Add a user" });
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Kim again" } });
    fireEvent.change(within(form).getByLabelText("Email"), { target: { value: "KIM@example.com" } });
    fireEvent.change(within(form).getByLabelText("First password"), { target: { value: "long enough 1" } });
    fireEvent.click(within(form).getByRole("button", { name: "Add user" }));
    expect((await screen.findByRole("alert")).textContent).toContain("That email address already has an account.");
    // The form stays, with what was typed.
    expect((within(form).getByLabelText("Name") as HTMLInputElement).value).toBe("Kim again");
  });

  it("changes a user's name, email and admin", async () => {
    const sent = stub();
    show();
    fireEvent.click(within(await row("Kim Smith")).getByRole("button", { name: "Edit Kim Smith" }));
    const form = screen.getByRole("form", { name: "Change Kim Smith" });
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Kim Jones" } });
    fireEvent.change(within(form).getByLabelText("Email"), { target: { value: "kim.jones@example.com" } });
    fireEvent.click(within(form).getByRole("checkbox", { name: /Admin/ }));
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    await screen.findByText("Saved Kim Jones.");
    expect(sent.find(([method]) => method === "PUT")).toEqual(["PUT", "/api/users/2", { name: "Kim Jones", email: "kim.jones@example.com", isAdmin: true }]);
    const kim = await row("Kim Jones");
    expect(kim.textContent).toContain("kim.jones@example.com");
    expect(kim.textContent).toContain("Admin");
  });

  it("warns an admin taking away their own admin, and shows the server's refusal for the last one", async () => {
    stub();
    show();
    fireEvent.click(within(await row("Sam Smith")).getByRole("button", { name: "Edit Sam Smith" }));
    const form = screen.getByRole("form", { name: "Change Sam Smith" });
    fireEvent.click(within(form).getByRole("checkbox", { name: /Admin/ }));
    expect(within(form).getByText("You will no longer be able to add, change or remove users.")).toBeTruthy();
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toContain("The household needs at least one admin.");
  });

  it("gives a user a new password", async () => {
    const sent = stub();
    show();
    fireEvent.click(within(await row("Kim Smith")).getByRole("button", { name: "New password for Kim Smith" }));
    const form = screen.getByRole("form", { name: "New password for Kim Smith" });
    fireEvent.change(within(form).getByLabelText("New password for Kim Smith"), { target: { value: "short" } });
    fireEvent.click(within(form).getByRole("button", { name: "Set password" }));
    expect(within(form).getByText("Choose a password of at least 10 characters.")).toBeTruthy();
    fireEvent.change(within(form).getByLabelText("New password for Kim Smith"), { target: { value: "kims new one 2" } });
    fireEvent.click(within(form).getByRole("button", { name: "Set password" }));
    await screen.findByText("Kim Smith has a new password and was signed out everywhere. Tell them the new one.");
    expect(sent.find(([method, path]) => method === "PUT" && path === "/api/users/2/password")?.[2]).toEqual({ password: "kims new one 2" });
  });

  it("removes a user only after asking, and Cancel keeps them", async () => {
    const sent = stub();
    show();
    fireEvent.click(within(await row("Kim Smith")).getByRole("button", { name: "Remove Kim Smith" }));
    const ask = screen.getByRole("group", { name: "Remove Kim Smith" });
    expect(ask.textContent).toContain("can no longer sign in");
    fireEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
    expect(sent.some(([method]) => method === "DELETE")).toBe(false);

    fireEvent.click(within(await row("Kim Smith")).getByRole("button", { name: "Remove Kim Smith" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Remove Kim Smith" })).getByRole("button", { name: "Remove Kim Smith" }));
    await screen.findByText("Removed Kim Smith.");
    expect(sent.find(([method]) => method === "DELETE")?.[1]).toBe("/api/users/2");
    await waitFor(() => expect(rowNames()).toEqual(["Sam Smith"]));
  });

  it("keeps one form open at a time", async () => {
    stub();
    show();
    fireEvent.click(within(await row("Kim Smith")).getByRole("button", { name: "Edit Kim Smith" }));
    expect(screen.getByRole("form", { name: "Change Kim Smith" })).toBeTruthy();
    fireEvent.click(within(await row("Sam Smith")).getByRole("button", { name: "Edit Sam Smith" }));
    expect(screen.queryByRole("form", { name: "Change Kim Smith" })).toBeNull();
    expect(screen.getByRole("form", { name: "Change Sam Smith" })).toBeTruthy();
  });
});
