import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ApiError,
  CaptureDetailResponse,
  CaptureListResponse,
  CaptureTagsResponse,
  MailboxListResponse,
  Tag,
  TagListResponse,
} from "../../src/shared/api.js";
import { MAX_TAGGED_AT_ONCE, MAX_TAGS } from "../../src/shared/tags.js";
import { call, json, makeServer, rawEmail, saveEmail, setUp, type TestServer } from "./helpers.js";

let server: TestServer;
let cookie: string;

const WATER = "proton-bills/1700000000/1";
const POWER = "proton-bills/1700000000/2";

beforeEach(async () => {
  server = makeServer();
  cookie = await setUp(server.app);
  await saveEmail(server.store, rawEmail({ subject: "Water bill", date: "Mon, 05 Oct 2026 09:00:00 +0000" }), { uid: 1 });
  await saveEmail(server.store, rawEmail({ subject: "Power bill", date: "Wed, 28 Oct 2026 09:00:00 +0000" }), { uid: 2 });
});

afterEach(() => {
  server.close();
});

const get = (path: string) => call(server.app, path, { cookie });

async function errorOf(res: Response): Promise<string> {
  return (await json<ApiError>(res)).error;
}

async function createTag(name: unknown): Promise<Response> {
  return call(server.app, "/api/tags", { method: "POST", body: { name }, cookie });
}

async function created(name: string): Promise<Tag> {
  const res = await createTag(name);
  if (res.status !== 201) throw new Error(`create failed: ${res.status} ${await res.text()}`);
  return json<Tag>(res);
}

async function change(body: unknown): Promise<Response> {
  return call(server.app, "/api/captures/tags", { method: "POST", body, cookie });
}

async function tags(): Promise<Tag[]> {
  return (await json<TagListResponse>(await get("/api/tags"))).tags;
}

/** Each listed email's tag names, by subject. */
async function listedTags(): Promise<Record<string, string[]>> {
  const { captures } = await json<CaptureListResponse>(await get("/api/captures"));
  return Object.fromEntries(captures.map((c) => [c.subject, c.tags.map((t) => t.name)]));
}

/** A second household with its own mailbox, one email in it, and one tag. */
async function otherHousehold(): Promise<{ captureId: string; tagId: number }> {
  const stamp = "2026-10-29T00:00:00.000Z";
  const household = server.db.run("INSERT INTO households (name, created_at) VALUES ('The Joneses', ?)", stamp).lastInsertRowid;
  server.db.run(
    `INSERT INTO mailboxes (household_id, name, slug, provider, host, port, security, username, folder, created_at, updated_at)
     VALUES (?, 'Their bills', 'their-bills', 'gmail', 'imap.gmail.com', 993, 'tls', 'jo@example.com', 'Bills', ?, ?)`,
    household,
    stamp,
    stamp,
  );
  await saveEmail(server.store, rawEmail({ subject: "Their bill" }), { uid: 7, mailbox: "Their bills" });
  const tagId = server.db.run(
    "INSERT INTO tags (household_id, name, name_key, created_at, updated_at) VALUES (?, 'Theirs', 'theirs', ?, ?)",
    household,
    stamp,
    stamp,
  ).lastInsertRowid;
  return { captureId: "their-bills/1700000000/7", tagId };
}

describe("tags", () => {
  it("needs a signed-in person", async () => {
    expect((await call(server.app, "/api/tags")).status).toBe(401);
    expect((await call(server.app, "/api/tags", { method: "POST", body: { name: "Utilities" } })).status).toBe(401);
    expect((await call(server.app, "/api/captures/tags", { method: "POST", body: { captureIds: [WATER], add: ["Utilities"] } })).status).toBe(401);
  });

  it("starts with none, and emails carry none", async () => {
    expect(await tags()).toEqual([]);
    expect(await listedTags()).toEqual({ "Water bill": [], "Power bill": [] });
  });

  it("adds a tag with its name tidied", async () => {
    const tag = await created("  Taxes \t 2026 ");
    expect(tag).toEqual({
      id: expect.any(Number),
      name: "Taxes 2026",
      emails: 0,
      createdAt: "2026-10-29T12:00:00.000Z",
      updatedAt: "2026-10-29T12:00:00.000Z",
    });
    expect(await tags()).toEqual([tag]);
  });

  it("lists tags by name, ignoring case", async () => {
    await created("water");
    await created("Auto");
    await created("bank");
    expect((await tags()).map((t) => t.name)).toEqual(["Auto", "bank", "water"]);
  });

  it("refuses a name the household already has, ignoring case, accents included", async () => {
    await created("Utilities");
    const same = await createTag("UTILITIES");
    expect(same.status).toBe(409);
    expect(await errorOf(same)).toBe("There is already a tag called Utilities.");
    await created("Été");
    expect((await createTag("été")).status).toBe(409);
  });

  it("refuses an empty, overlong or hidden-character name", async () => {
    const empty = await createTag("   ");
    expect(empty.status).toBe(400);
    expect(await errorOf(empty)).toBe("Enter a name for the tag.");
    const long = await createTag("x".repeat(41));
    expect(await errorOf(long)).toBe("Keep tag names under 40 characters.");
    expect((await createTag("x".repeat(40))).status).toBe(201);
    const hidden = await createTag("Water​bill");
    expect(await errorOf(hidden)).toBe("Tag names cannot hold hidden characters. Type the name again.");
    expect((await createTag(42)).status).toBe(400);
    // The joiner inside an emoji is allowed.
    expect((await createTag("Family \u{1F468}‍\u{1F469}‍\u{1F467}")).status).toBe(201);
  });

  it(`stops at ${MAX_TAGS} tags`, async () => {
    const stamp = "2026-10-29T00:00:00.000Z";
    for (let i = 0; i < MAX_TAGS; i++) {
      server.db.run("INSERT INTO tags (household_id, name, name_key, created_at, updated_at) VALUES (1, ?, ?, ?, ?)", `t${i}`, `t${i}`, stamp, stamp);
    }
    const res = await createTag("One more");
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toContain(`You already have ${MAX_TAGS} tags`);
    const viaEmail = await change({ captureIds: [WATER], add: ["One more"] });
    expect(viaEmail.status).toBe(409);
    // An existing tag can still be used.
    expect((await change({ captureIds: [WATER], add: ["T5"] })).status).toBe(200);
  });

  it("renames a tag, including only its case", async () => {
    const tag = await created("utilities");
    server.clock.now = new Date("2026-10-30T08:00:00Z");
    const res = await call(server.app, `/api/tags/${tag.id}`, { method: "PUT", body: { name: "Utilities" }, cookie });
    expect(res.status).toBe(200);
    expect(await json<Tag>(res)).toMatchObject({ id: tag.id, name: "Utilities", updatedAt: "2026-10-30T08:00:00.000Z" });
    await created("Water");
    const clash = await call(server.app, `/api/tags/${tag.id}`, { method: "PUT", body: { name: "water" }, cookie });
    expect(clash.status).toBe(409);
    expect(await errorOf(clash)).toBe("There is already a tag called Water.");
  });

  it("shows a renamed tag on its emails", async () => {
    const tag = await created("Utility");
    await change({ captureIds: [WATER], add: ["Utility"] });
    await call(server.app, `/api/tags/${tag.id}`, { method: "PUT", body: { name: "Utilities" }, cookie });
    expect((await listedTags())["Water bill"]).toEqual(["Utilities"]);
  });

  it("deletes a tag and takes it off every email", async () => {
    const tag = await created("Utilities");
    await change({ captureIds: [WATER, POWER], add: ["Utilities", "Paid"] });
    const res = await call(server.app, `/api/tags/${tag.id}`, { method: "DELETE", cookie });
    expect(res.status).toBe(204);
    expect(await listedTags()).toEqual({ "Water bill": ["Paid"], "Power bill": ["Paid"] });
    expect(server.db.get<{ n: number }>("SELECT count(*) AS n FROM capture_tags WHERE tag_id = ?", tag.id)?.n).toBe(0);
    expect((await call(server.app, `/api/tags/${tag.id}`, { method: "DELETE", cookie })).status).toBe(404);
  });

  it("treats a bad or unknown id as not found", async () => {
    for (const id of ["0", "abc", "999", "1.5"]) {
      expect((await call(server.app, `/api/tags/${id}`, { method: "PUT", body: { name: "X" }, cookie })).status).toBe(404);
      expect((await call(server.app, `/api/tags/${id}`, { method: "DELETE", cookie })).status).toBe(404);
    }
  });

  it("keeps another household's tags out of reach", async () => {
    const other = await otherHousehold();
    expect(await tags()).toEqual([]);
    expect((await call(server.app, `/api/tags/${other.tagId}`, { method: "PUT", body: { name: "Mine" }, cookie })).status).toBe(404);
    expect((await call(server.app, `/api/tags/${other.tagId}`, { method: "DELETE", cookie })).status).toBe(404);
    const remove = await change({ captureIds: [WATER], remove: [other.tagId] });
    expect(remove.status).toBe(404);
    expect(await errorOf(remove)).toBe("That tag was not found. It may have been deleted.");
    // A name can be used in each household.
    expect((await createTag("Theirs")).status).toBe(201);
  });
});

describe("tagging emails", () => {
  it("adds tags by name, making new ones, and shows them on the list and the email", async () => {
    const existing = await created("Utilities");
    const res = await change({ captureIds: [WATER, POWER], add: ["utilities", "Paid"] });
    expect(res.status).toBe(200);
    const body = await json<CaptureTagsResponse>(res);
    const paid = body.created[0]!;
    expect(body).toEqual({
      captures: [
        { id: WATER, tags: [{ id: paid.id, name: "Paid" }, { id: existing.id, name: "Utilities" }] },
        { id: POWER, tags: [{ id: paid.id, name: "Paid" }, { id: existing.id, name: "Utilities" }] },
      ],
      created: [{ id: expect.any(Number), name: "Paid" }],
    });
    expect(await listedTags()).toEqual({ "Water bill": ["Paid", "Utilities"], "Power bill": ["Paid", "Utilities"] });
    const detail = await json<CaptureDetailResponse>(await get(`/api/captures/${WATER}`));
    expect(detail.tags).toEqual([{ id: paid.id, name: "Paid" }, { id: existing.id, name: "Utilities" }]);
    expect((await tags()).map((t) => [t.name, t.emails])).toEqual([["Paid", 2], ["Utilities", 2]]);
  });

  it("adding a tag twice changes nothing", async () => {
    await change({ captureIds: [WATER], add: ["Paid"] });
    const again = await change({ captureIds: [WATER, WATER], add: ["Paid", "PAID"] });
    expect(again.status).toBe(200);
    const body = await json<CaptureTagsResponse>(again);
    expect(body.created).toEqual([]);
    expect(body.captures).toHaveLength(1);
    expect((await tags()).map((t) => [t.name, t.emails])).toEqual([["Paid", 1]]);
  });

  it("removes a tag from some emails only", async () => {
    await change({ captureIds: [WATER, POWER], add: ["Paid"] });
    const paid = (await tags())[0]!;
    const res = await change({ captureIds: [POWER], remove: [paid.id] });
    expect(res.status).toBe(200);
    expect(await listedTags()).toEqual({ "Water bill": ["Paid"], "Power bill": [] });
    // The tag stays, with its other email.
    expect((await tags()).map((t) => [t.name, t.emails])).toEqual([["Paid", 1]]);
  });

  it("adds and removes different tags in one change", async () => {
    await change({ captureIds: [WATER], add: ["Unpaid"] });
    const unpaid = (await tags())[0]!;
    expect((await change({ captureIds: [WATER], add: ["Paid"], remove: [unpaid.id] })).status).toBe(200);
    expect((await listedTags())["Water bill"]).toEqual(["Paid"]);
    const both = await change({ captureIds: [WATER], add: ["Paid"], remove: [(await tags()).find((t) => t.name === "Paid")!.id] });
    expect(both.status).toBe(400);
    expect(await errorOf(both)).toBe("A tag cannot be added and removed at the same time.");
  });

  it("refuses a change with no tag, no email, or too many emails", async () => {
    const none = await change({ captureIds: [WATER] });
    expect(none.status).toBe(400);
    expect(await errorOf(none)).toBe("Choose a tag to add or remove.");
    const noEmail = await change({ captureIds: [], add: ["Paid"] });
    expect(await errorOf(noEmail)).toBe("Choose at least one email.");
    const many = Array.from({ length: MAX_TAGGED_AT_ONCE + 1 }, (_, i) => `proton-bills/1700000000/${i + 1}`);
    const tooMany = await change({ captureIds: many, add: ["Paid"] });
    expect(tooMany.status).toBe(400);
    expect(await errorOf(tooMany)).toBe(`Tag at most ${MAX_TAGGED_AT_ONCE} emails at once.`);
    const badName = await change({ captureIds: [WATER], add: [" "] });
    expect(await errorOf(badName)).toBe("Enter a name for the tag.");
    expect(await tags()).toEqual([]);
  });

  it("changes nothing when one email is not the household's or does not exist", async () => {
    const other = await otherHousehold();
    for (const bad of [other.captureId, "proton-bills/1700000000/99", "proton-bills/1700000000/01", "../x/1", "proton-bills/1700000000", "nope/1/1"]) {
      const res = await change({ captureIds: [WATER, bad], add: ["Paid"] });
      expect(res.status).toBe(404);
      expect(await errorOf(res)).toContain("One of those emails was not found.");
    }
    expect(await tags()).toEqual([]);
    expect((await listedTags())["Water bill"]).toEqual([]);
  });

  it("keeps a removed mailbox's tags, uncounted, until it is restored", async () => {
    await change({ captureIds: [WATER], add: ["Paid"] });
    const { mailboxes } = await json<MailboxListResponse>(await get("/api/mailboxes"));
    expect((await call(server.app, `/api/mailboxes/${mailboxes[0]!.id}`, { method: "DELETE", cookie })).status).toBe(204);
    expect((await tags()).map((t) => [t.name, t.emails])).toEqual([["Paid", 0]]);
    // Its emails cannot be tagged while it is removed.
    expect((await change({ captureIds: [POWER], add: ["Paid"] })).status).toBe(404);
    // Restored (as restoring does to the row): the tag is back on its email.
    server.db.run("UPDATE mailboxes SET removed_at = NULL WHERE id = ?", mailboxes[0]!.id);
    expect((await tags()).map((t) => [t.name, t.emails])).toEqual([["Paid", 1]]);
    expect((await listedTags())["Water bill"]).toEqual(["Paid"]);
  });
});
