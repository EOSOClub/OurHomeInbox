// @vitest-environment jsdom
// Tags in the web app against a stand-in server that keeps tags the way the
// real one does: on an email's page, selecting several emails in the list,
// the list's tag filter, and the Tags page.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extract } from "../../../src/server/extraction";
import { checkSender } from "../../../src/server/sender";
import type { CaptureDetailResponse, CaptureListItem, CaptureTagsRequest, Tag, TagRef } from "../../../src/shared/api";
import type { Capture } from "../../../src/shared/capture";
import { tagKey } from "../../../src/shared/tags";
import { CaptureDetailPage } from "../pages/CaptureDetailPage";
import { CaptureListPage } from "../pages/CaptureListPage";
import { TagsPage } from "../pages/TagsPage";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function makeCapture(uid: number, subject: string): Capture {
  return {
    version: 1,
    mailbox: "Proton bills",
    folder: "Folders/Bills",
    uidValidity: "1",
    uid,
    capturedAt: "2026-10-29T15:00:00Z",
    raw: { file: "message.eml", size: 100, sha256: "a".repeat(64) },
    messageId: null,
    subject,
    date: `2026-10-0${uid}T09:00:00Z`,
    from: [{ name: "City Water", address: "bills@water.example" }],
    to: [],
    cc: [],
    replyTo: [],
    headers: [],
    text: "Amount due: $42.10",
    html: null,
    attachments: [],
    links: [],
  };
}

const EMAILS = [makeCapture(1, "Water bill"), makeCapture(2, "Power bill"), makeCapture(3, "Gas bill")];
const idOf = (capture: Capture) => `proton-bills/1/${capture.uid}`;

function reply(status: number, body?: unknown): Response {
  return body === undefined ? new Response(null, { status }) : new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** A stand-in server holding `initial` tags on the emails in `on` (capture id to tag ids). Records what was sent. */
function stubServer(initial: string[] = [], on: Record<string, number[]> = {}, fail: string | null = null) {
  let nextId = 1;
  const tags: Tag[] = initial.map((name) => ({ id: nextId++, name, emails: 0, createdAt: "", updatedAt: "" }));
  const tagged = new Map<string, Set<number>>(Object.entries(on).map(([id, ids]) => [id, new Set(ids)]));
  const sent: Array<[string, string, unknown]> = [];

  const refs = (captureId: string): TagRef[] =>
    tags
      .filter((t) => tagged.get(captureId)?.has(t.id))
      .sort((a, b) => tagKey(a.name).localeCompare(tagKey(b.name)))
      .map(({ id, name }) => ({ id, name }));
  const listed = (): Tag[] =>
    [...tags]
      .sort((a, b) => tagKey(a.name).localeCompare(tagKey(b.name)))
      .map((t) => ({ ...t, emails: [...tagged.values()].filter((set) => set.has(t.id)).length }));
  const detail = (capture: Capture): CaptureDetailResponse => ({
    id: idOf(capture),
    mailboxSlug: "proton-bills",
    capture,
    biller: null,
    sender: checkSender(capture),
    invoice: null,
    extraction: extract(capture),
    tags: refs(idOf(capture)),
    review: null,
  });
  const item = (capture: Capture): CaptureListItem => ({
    id: idOf(capture),
    mailbox: "Proton bills",
    mailboxSlug: "proton-bills",
    folder: "Folders/Bills",
    uidValidity: "1",
    uid: capture.uid,
    subject: capture.subject,
    from: capture.from,
    date: capture.date,
    capturedAt: capture.capturedAt,
    attachmentCount: 0,
    linkCount: 0,
    hasText: true,
    hasHtml: false,
    biller: null,
    senderVerified: false,
    picked: { kind: "bill", amount: null, dueDate: null, paidDate: null, dueNow: false, needsCheck: false, values: {} },
    tags: refs(idOf(capture)),
    review: null,
  });

  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
      sent.push([method, path, body]);
      if (method !== "GET" && fail) return reply(409, { error: fail });
      if (method === "GET" && path === "/api/tags") return reply(200, { tags: listed() });
      if (method === "GET" && path === "/api/billers") return reply(200, { billers: [] });
      if (method === "GET" && path === "/api/captures") return reply(200, { captures: [...EMAILS].reverse().map(item) });
      const one = EMAILS.find((c) => path === `/api/captures/${idOf(c)}`);
      if (method === "GET" && one) return reply(200, detail(one));
      if (method === "POST" && path === "/api/tags") {
        const tag = { id: nextId++, name: (body as { name: string }).name, emails: 0, createdAt: "", updatedAt: "" };
        tags.push(tag);
        return reply(201, tag);
      }
      const tagPath = /^\/api\/tags\/(\d+)$/.exec(path);
      if (tagPath) {
        const tag = tags.find((t) => t.id === Number(tagPath[1]));
        if (!tag) return reply(404, { error: "That tag was not found." });
        if (method === "PUT") tag.name = (body as { name: string }).name;
        if (method === "DELETE") {
          tags.splice(tags.indexOf(tag), 1);
          for (const set of tagged.values()) set.delete(tag.id);
          return reply(204);
        }
        return reply(200, tag);
      }
      if (method === "POST" && path === "/api/captures/tags") {
        const request = body as CaptureTagsRequest;
        const created: TagRef[] = [];
        const addIds = (request.add ?? []).map((name) => {
          let tag = tags.find((t) => tagKey(t.name) === tagKey(name));
          if (!tag) {
            tag = { id: nextId++, name, emails: 0, createdAt: "", updatedAt: "" };
            tags.push(tag);
            created.push({ id: tag.id, name });
          }
          return tag.id;
        });
        for (const id of request.captureIds) {
          const set = tagged.get(id) ?? new Set<number>();
          for (const tagId of request.remove ?? []) set.delete(tagId);
          for (const tagId of addIds) set.add(tagId);
          tagged.set(id, set);
        }
        return reply(200, { captures: request.captureIds.map((id) => ({ id, tags: refs(id) })), created });
      }
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
          <Route path="/" element={<CaptureListPage />} />
          <Route path="/mail/:mailbox/:uidValidity/:uid" element={<CaptureDetailPage />} />
          <Route path="/tags" element={<TagsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The Tags row of an email's details. */
async function tagsRow(): Promise<HTMLElement> {
  const label = await screen.findByText("Tags", { selector: "dt" });
  return label.parentElement!;
}

describe("tags on an email's page", () => {
  it("adds a tag by name and takes one off", async () => {
    const sent = stubServer(["Utilities"]);
    show("/mail/proton-bills/1/1");
    const row = await tagsRow();
    expect(row.textContent).toContain("None");

    fireEvent.click(within(row).getByRole("button", { name: "Add a tag" }));
    const box = within(row).getByRole("combobox", { name: "Tag to add to this email" }) as HTMLInputElement;
    fireEvent.change(box, { target: { value: "  Paid  " } });
    fireEvent.submit(box.form!); // Enter in the box
    await within(row).findByRole("button", { name: "Remove the tag Paid" });
    expect(sent).toContainEqual(["POST", "/api/captures/tags", { captureIds: ["proton-bills/1/1"], add: ["Paid"] }]);
    // The box stays open, empty, with the cursor in it for the next tag.
    expect(within(row).getByRole("combobox")).toBe(box);
    expect(box.value).toBe("");
    expect(document.activeElement).toBe(box);

    // A second tag the same way, clicking Add this time.
    fireEvent.change(box, { target: { value: "Taxes" } });
    fireEvent.click(within(row).getByRole("button", { name: "Add" }));
    await within(row).findByRole("button", { name: "Remove the tag Taxes" });
    expect(document.activeElement).toBe(box);

    // A click inside the box keeps it open; a click anywhere outside closes it.
    fireEvent.pointerDown(box);
    expect(within(row).getByRole("combobox")).toBe(box);
    fireEvent.pointerDown(document.body);
    expect(within(row).queryByRole("combobox")).toBeNull();
    expect(within(row).getByRole("button", { name: "Add a tag" })).toBeTruthy();

    fireEvent.click(within(row).getByRole("button", { name: "Remove the tag Paid" }));
    await waitFor(() => expect(within(row).queryByRole("button", { name: "Remove the tag Paid" })).toBeNull());
    expect(sent).toContainEqual(["POST", "/api/captures/tags", { captureIds: ["proton-bills/1/1"], remove: [2] }]);
  });

  it("checks the name before sending it", async () => {
    const sent = stubServer(["Paid"], { "proton-bills/1/1": [1] });
    show("/mail/proton-bills/1/1");
    const row = await tagsRow();
    await within(row).findByRole("button", { name: "Remove the tag Paid" });
    fireEvent.click(within(row).getByRole("button", { name: "Add a tag" }));
    const box = within(row).getByRole("combobox", { name: "Tag to add to this email" });
    fireEvent.click(within(row).getByRole("button", { name: "Add" }));
    expect(within(row).getByText("Enter a name for the tag.")).toBeTruthy();
    fireEvent.change(box, { target: { value: "PAID" } });
    fireEvent.click(within(row).getByRole("button", { name: "Add" }));
    expect(within(row).getByText("It already has the tag Paid.")).toBeTruthy();
    fireEvent.keyDown(box, { key: "Escape" });
    expect(within(row).queryByRole("combobox")).toBeNull();
    expect(sent.filter(([method]) => method === "POST")).toEqual([]);
  });

  it("says why a change did not work", async () => {
    stubServer([], {}, "You already have 200 tags, the most one household can have.");
    show("/mail/proton-bills/1/1");
    const row = await tagsRow();
    fireEvent.click(within(row).getByRole("button", { name: "Add a tag" }));
    fireEvent.change(within(row).getByRole("combobox"), { target: { value: "One more" } });
    fireEvent.click(within(row).getByRole("button", { name: "Add" }));
    expect((await within(row).findByRole("alert")).textContent).toContain("Could not change the tags: You already have 200 tags");
    // The box stays open with the name, to try again.
    expect((within(row).getByRole("combobox") as HTMLInputElement).value).toBe("One more");
  });
});

describe("tags in the captured-mail list", () => {
  it("shows each email's tags and filters by tag from the page address", async () => {
    stubServer(["Paid", "Taxes"], { "proton-bills/1/1": [1, 2], "proton-bills/1/2": [1] });
    show("/?tag=2");
    await screen.findByText("Showing 1 of 3 emails");
    expect(screen.getByText("Water bill")).toBeTruthy();
    expect(screen.queryByText("Power bill")).toBeNull();

    const filter = screen.getByRole("combobox", { name: "Tag" });
    fireEvent.change(filter, { target: { value: "none" } });
    await screen.findByText("Gas bill");
    expect(screen.queryByText("Water bill")).toBeNull();

    fireEvent.change(filter, { target: { value: "all" } });
    await screen.findByText("3 emails");
    const water = screen.getByText("Water bill").closest("a")!;
    expect(within(within(water).getByRole("list", { name: "Tags" })).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Paid", "Taxes"]);
  });

  it("tags several emails at once and takes a tag off them", async () => {
    const sent = stubServer(["Paid"], { "proton-bills/1/3": [1] });
    show("/");
    fireEvent.click(await screen.findByRole("button", { name: "Select" }));
    const bar = screen.getByRole("region", { name: "Selected emails" });
    expect(bar.textContent).toContain("None selected.");

    fireEvent.click(screen.getByRole("checkbox", { name: /^Select: Water bill/ }));
    fireEvent.click(screen.getByText("Power bill"));
    expect(bar.textContent).toContain("2 selected");
    fireEvent.change(within(bar).getByRole("combobox", { name: "Tag to add to the 2 emails" }), { target: { value: "Utilities" } });
    fireEvent.click(within(bar).getByRole("button", { name: "Add tag" }));
    await within(bar).findByText("Added Utilities to 2 emails.");
    // The rows show the tag with the message, before the list reloads.
    expect(within(screen.getByText("Water bill").closest("li")!).getByRole("list", { name: "Tags" }).textContent).toBe("Utilities");
    expect(sent).toContainEqual(["POST", "/api/captures/tags", { captureIds: ["proton-bills/1/2", "proton-bills/1/1"], add: ["Utilities"] }]);

    // Select all shown, then take Paid off: only the one email that had it changes.
    fireEvent.click(within(bar).getByRole("button", { name: "Select all shown" }));
    expect(bar.textContent).toContain("3 selected");
    const remove = within(bar).getByRole("combobox", { name: "Tag to take off the 3 emails" });
    await waitFor(() => expect(within(remove).getAllByRole("option").map((o) => o.textContent)).toEqual(["Take a tag off...", "Paid", "Utilities"]));
    fireEvent.change(remove, { target: { value: "1" } });
    fireEvent.click(within(bar).getByRole("button", { name: "Remove" }));
    await within(bar).findByText("Took Paid off 1 email.");

    fireEvent.click(within(bar).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("region", { name: "Selected emails" })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});

describe("the Tags page", () => {
  it("adds, renames and deletes a tag, deleting only after a confirmation", async () => {
    const sent = stubServer(["Paid"], { "proton-bills/1/1": [1], "proton-bills/1/2": [1] });
    show("/tags");
    const link = await screen.findByRole("link", { name: "2 emails" });
    expect(link.getAttribute("href")).toBe("/?tag=1");

    fireEvent.change(screen.getByRole("textbox", { name: "New tag name" }), { target: { value: "Taxes" } });
    fireEvent.click(screen.getByRole("button", { name: "Add a tag" }));
    fireEvent.click(await screen.findByRole("button", { name: "Rename Taxes" }));
    expect(screen.getByText("2 tags")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "New tag name" }) as HTMLInputElement).value).toBe("");

    const rename = screen.getByRole("textbox", { name: "New name for Taxes" });
    fireEvent.change(rename, { target: { value: "Taxes 2026" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("button", { name: "Rename Taxes 2026" });
    expect(sent).toContainEqual(["PUT", "/api/tags/2", { name: "Taxes 2026" }]);

    fireEvent.click(screen.getByRole("button", { name: "Delete Paid" }));
    const confirm = screen.getByRole("group", { name: "Delete Paid?" });
    expect(confirm.textContent).toContain("It comes off 2 emails. The emails stay.");
    expect(sent.some(([method]) => method === "DELETE")).toBe(false);
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByText("Paid")).toBeNull());
    expect(sent).toContainEqual(["DELETE", "/api/tags/1", undefined]);
  });
});
