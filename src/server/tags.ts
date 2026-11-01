// The household's tags, and which of its emails carry them:
//   GET    /api/tags            every tag, by name, with how many emails carry it
//   POST   /api/tags            add one
//   PUT    /api/tags/:id        rename one
//   DELETE /api/tags/:id        delete one (it comes off every email)
//   POST   /api/captures/tags   tag or untag one or more emails
//
// Everything is scoped to the signed-in person's household, and only emails
// in its own mailboxes can be tagged. Another household's tag is "not
// found", never "forbidden", so its existence does not leak.
//
// An email is named by its capture id ("<slug>/<uidValidity>/<uid>"). Its
// tags stay with it while its mailbox is removed, and come back when the
// mailbox is restored.

import { Hono, type Context } from "hono";
import { z } from "zod";
import type { CaptureTagsResponse, Tag, TagListResponse, TagRef } from "../shared/api.js";
import { MAX_TAGGED_AT_ONCE, MAX_TAGS, normalizeTagName, tagKey, tagNameProblem } from "../shared/tags.js";
import type { CaptureStore } from "../store.js";
import type { Database } from "./db.js";
import { apiError, householdOf, jsonBody, MESSAGES, type AppEnv } from "./http.js";
import { isCapturedIn } from "./mail.js";
import type { Mailboxes } from "./mailboxes.js";

export interface TagDeps {
  db: Database;
  store: CaptureStore;
  mailboxes: Mailboxes;
  now: () => Date;
}

export const NOT_FOUND = "That tag was not found. It may have been deleted.";
const EMAIL_NOT_FOUND = "One of those emails was not found. It may be in a mailbox that is no longer set up. Nothing was changed.";
const TOO_MANY_TAGS = `You already have ${MAX_TAGS} tags, the most one household can have. Delete one you no longer use first.`;
const ID = /^[1-9]\d*$/;

const tagName = z
  .string({ error: "Enter a name for the tag." })
  // Generous: tagNameProblem gives the real message for a long one.
  .max(1000, "That tag name is far too long.")
  .transform(normalizeTagName)
  .superRefine((name, ctx) => {
    const problem = tagNameProblem(name);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  });

const tagSchema = z.object({ name: tagName }, { error: MESSAGES.badShape });

const captureTagsSchema = z
  .object(
    {
      captureIds: z
        .array(z.string({ error: MESSAGES.badShape }).max(300, EMAIL_NOT_FOUND), { error: MESSAGES.badShape })
        .min(1, "Choose at least one email.")
        .transform((ids) => [...new Set(ids)])
        .refine((ids) => ids.length <= MAX_TAGGED_AT_ONCE, `Tag at most ${MAX_TAGGED_AT_ONCE} emails at once.`),
      add: z.array(tagName, { error: MESSAGES.badShape }).max(MAX_TAGS, MESSAGES.badShape).default([]),
      remove: z.array(z.number({ error: MESSAGES.badShape }).int().positive(), { error: MESSAGES.badShape }).max(MAX_TAGS, MESSAGES.badShape).default([]),
    },
    { error: MESSAGES.badShape },
  )
  .refine((body) => body.add.length > 0 || body.remove.length > 0, "Choose a tag to add or remove.");

interface TagRow {
  id: number;
  name: string;
  created_at: string;
  updated_at: string;
}

/** The household's tags on each of its emails, by capture id, each list by name. */
export function captureTags(db: Database, householdId: number): Map<string, TagRef[]> {
  const byCapture = new Map<string, TagRef[]>();
  for (const row of db.all<{ capture_id: string; id: number; name: string }>(
    `SELECT ct.capture_id, t.id, t.name FROM capture_tags ct JOIN tags t ON t.id = ct.tag_id
     WHERE ct.household_id = ? ORDER BY t.name_key, t.id`,
    householdId,
  )) {
    const list = byCapture.get(row.capture_id);
    const tag = { id: row.id, name: row.name };
    if (list) list.push(tag);
    else byCapture.set(row.capture_id, [tag]);
  }
  return byCapture;
}

/** The household's tags on one email, by name. */
export function tagsOn(db: Database, householdId: number, captureId: string): TagRef[] {
  return db.all<TagRef>(
    `SELECT t.id, t.name FROM capture_tags ct JOIN tags t ON t.id = ct.tag_id
     WHERE ct.household_id = ? AND ct.capture_id = ? ORDER BY t.name_key, t.id`,
    householdId,
    captureId,
  );
}

/** The mailbox slug a capture id starts with. */
function slugOf(captureId: string): string {
  return captureId.slice(0, captureId.indexOf("/"));
}

/** Every tag of the household, by name, counting only emails in `slugs` (its mailboxes that are set up). */
export function listTags(db: Database, householdId: number, slugs: ReadonlySet<string>): Tag[] {
  const counts = new Map<number, number>();
  for (const row of db.all<{ tag_id: number; capture_id: string }>(
    "SELECT tag_id, capture_id FROM capture_tags WHERE household_id = ?",
    householdId,
  )) {
    if (slugs.has(slugOf(row.capture_id))) counts.set(row.tag_id, (counts.get(row.tag_id) ?? 0) + 1);
  }
  return db
    .all<TagRow>("SELECT id, name, created_at, updated_at FROM tags WHERE household_id = ? ORDER BY name_key, id", householdId)
    .map((row) => ({ id: row.id, name: row.name, emails: counts.get(row.id) ?? 0, createdAt: row.created_at, updatedAt: row.updated_at }));
}

function tagId(c: Context): number | null {
  const text = c.req.param("id") ?? "";
  if (!ID.test(text)) return null;
  const id = Number(text);
  return Number.isSafeInteger(id) ? id : null;
}

/** The tag named like `name` (ignoring case), other than `exceptId`. */
function sameName(db: Database, householdId: number, name: string, exceptId: number | null): TagRow | undefined {
  return db.get<TagRow>(
    "SELECT id, name, created_at, updated_at FROM tags WHERE household_id = ? AND name_key = ? AND id IS NOT ?",
    householdId,
    tagKey(name),
    exceptId,
  );
}

function tagCount(db: Database, householdId: number): number {
  return db.get<{ n: number }>("SELECT count(*) AS n FROM tags WHERE household_id = ?", householdId)?.n ?? 0;
}

function insertTag(db: Database, householdId: number, name: string, stamp: string): number {
  return db.run(
    "INSERT INTO tags (household_id, name, name_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    householdId,
    name,
    tagKey(name),
    stamp,
    stamp,
  ).lastInsertRowid;
}

export function tagRoutes(deps: TagDeps): Hono<AppEnv> {
  const { db, store, mailboxes, now } = deps;
  const app = new Hono<AppEnv>();

  const slugsOf = (householdId: number) => new Set(mailboxes.places(householdId).keys());
  const oneTag = (householdId: number, id: number) => listTags(db, householdId, slugsOf(householdId)).find((tag) => tag.id === id);

  app.get("/tags", (c) => {
    const householdId = householdOf(c);
    const body: TagListResponse = { tags: listTags(db, householdId, slugsOf(householdId)) };
    return c.json(body);
  });

  app.post("/tags", jsonBody(tagSchema), (c) => {
    const householdId = householdOf(c);
    const { name } = c.req.valid("json");
    // The checks and the insert are one transaction, so two saves racing cannot both pass them.
    const result = db.transaction((): { problem: string } | { id: number } => {
      const taken = sameName(db, householdId, name, null);
      if (taken) return { problem: `There is already a tag called ${taken.name}.` };
      if (tagCount(db, householdId) >= MAX_TAGS) return { problem: TOO_MANY_TAGS };
      return { id: insertTag(db, householdId, name, now().toISOString()) };
    });
    if ("problem" in result) return apiError(c, 409, result.problem);
    return c.json(oneTag(householdId, result.id)!, 201);
  });

  app.put("/tags/:id", jsonBody(tagSchema), (c) => {
    const id = tagId(c);
    if (id === null) return apiError(c, 404, NOT_FOUND);
    const householdId = householdOf(c);
    const { name } = c.req.valid("json");
    const result = db.transaction((): { missing: true } | { problem: string } | { saved: true } => {
      if (!db.get("SELECT 1 FROM tags WHERE id = ? AND household_id = ?", id, householdId)) return { missing: true };
      // Itself excepted, so changing only upper and lower case works.
      const taken = sameName(db, householdId, name, id);
      if (taken) return { problem: `There is already a tag called ${taken.name}.` };
      db.run("UPDATE tags SET name = ?, name_key = ?, updated_at = ? WHERE id = ?", name, tagKey(name), now().toISOString(), id);
      return { saved: true };
    });
    if ("missing" in result) return apiError(c, 404, NOT_FOUND);
    if ("problem" in result) return apiError(c, 409, result.problem);
    return c.json(oneTag(householdId, id)!);
  });

  app.delete("/tags/:id", (c) => {
    const id = tagId(c);
    // Its capture_tags rows go with it (ON DELETE CASCADE).
    const removed = id === null ? 0 : db.run("DELETE FROM tags WHERE id = ? AND household_id = ?", id, householdOf(c)).changes;
    if (removed === 0) return apiError(c, 404, NOT_FOUND);
    return c.body(null, 204);
  });

  app.post("/captures/tags", jsonBody(captureTagsSchema), (c) => {
    const householdId = householdOf(c);
    const { captureIds, add, remove } = c.req.valid("json");
    const slugs = slugsOf(householdId);
    if (!captureIds.every((id) => isCapturedIn(store, id, slugs))) return apiError(c, 404, EMAIL_NOT_FOUND);
    const stamp = now().toISOString();

    const result = db.transaction((): { status: 400 | 404 | 409; problem: string } | { created: TagRef[] } => {
      for (const id of remove) {
        if (!db.get("SELECT 1 FROM tags WHERE id = ? AND household_id = ?", id, householdId)) return { status: 404, problem: NOT_FOUND };
      }
      // Each name to add, as the household's tag; a new name makes a new tag.
      const addIds = new Set<number>();
      const created: TagRef[] = [];
      for (const name of add) {
        const existing = sameName(db, householdId, name, null);
        if (existing) {
          addIds.add(existing.id);
          continue;
        }
        if (tagCount(db, householdId) >= MAX_TAGS) return { status: 409, problem: TOO_MANY_TAGS };
        const id = insertTag(db, householdId, name, stamp);
        addIds.add(id);
        created.push({ id, name });
      }
      if (remove.some((id) => addIds.has(id))) return { status: 400, problem: "A tag cannot be added and removed at the same time." };

      for (const captureId of captureIds) {
        for (const id of remove) db.run("DELETE FROM capture_tags WHERE tag_id = ? AND capture_id = ?", id, captureId);
        for (const id of addIds) {
          db.run(
            "INSERT OR IGNORE INTO capture_tags (tag_id, household_id, capture_id, created_at) VALUES (?, ?, ?, ?)",
            id,
            householdId,
            captureId,
            stamp,
          );
        }
      }
      return { created };
    });
    if ("problem" in result) return apiError(c, result.status, result.problem);

    const body: CaptureTagsResponse = {
      captures: captureIds.map((id) => ({ id, tags: tagsOn(db, householdId, id) })),
      created: result.created,
    };
    return c.json(body);
  });

  return app;
}
