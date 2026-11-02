// The hand-off to OurHome (the vault's "Hand-off" note; the contract is its
// section 6, and shared/handoff.ts has its types).
//
// For OurHome, with its token (`Authorization: Bearer ohi_...`), never a sign-in:
//   GET  /api/handoff/hello                           the household, the newest number, the start date
//   GET  /api/handoff/documents?after=<n>&limit=<m>   what is new or changed since n
//   POST /api/handoff/changes                         what a person did to an email bill in OurHome (contract v2)
//
// For the household, signed in (Settings, "OurHome connection"):
//   GET    /api/ourhome          the connection
//   POST   /api/ourhome/token    a new token, shown once; replaces the old
//   DELETE /api/ourhome/token    the token stops working
//   PUT    /api/ourhome          change the start date
//
// OurHome pulls; OurHomeInbox never writes to it. Each time OurHome asks, the
// household's emails are read and the offers brought up to date
// (store.ts), so a value fixed or a mark changed since is offered again.
// Without a live token nothing is offered at all. Bills are numbered before
// payments, so a payment always comes after the bill it references; a payment
// first offered as ready has its pairing locked (payments/store.ts).

import { Hono, type Context } from "hono";
import { z } from "zod";
import type { SessionUser } from "../../shared/api.js";
import {
  HANDOFF_DEFAULT_LIMIT,
  HANDOFF_MAX_CHANGES,
  HANDOFF_MAX_LIMIT,
  OURHOME_LIMITS,
  type HandoffChangesResponse,
  type HandoffDocumentsResponse,
  type HandoffHelloResponse,
  type OurHomeTokenResponse,
} from "../../shared/handoff.js";
import type { CaptureStore } from "../../store.js";
import type { CaptureCache } from "../captureCache.js";
import { readHouseholdEmails, type HouseholdEmail } from "../captures.js";
import type { Database } from "../db.js";
import { lockPairings, recordChanges } from "../payments/store.js";
import {
  applyDecisions,
  connectionInfo,
  connectionRow,
  createToken,
  householdForToken,
  liveStartDate,
  newestNumber,
  noteAsked,
  offersAfter,
  revokeToken,
  setStartDate,
} from "./store.js";
import { apiError, householdOf, jsonBody, MESSAGES, type AppEnv } from "../http.js";
import type { Mailboxes } from "../mailboxes.js";

export interface HandoffDeps {
  store: CaptureStore;
  db: Database;
  mailboxes: Mailboxes;
  cache: CaptureCache;
  now: () => Date;
}

const NO_TOKEN = "OurHome sent no token. Make one in OurHomeInbox (Settings, OurHome connection) and paste it into OurHome.";
const BAD_TOKEN = "That token does not work. It may have been replaced or turned off in OurHomeInbox (Settings, OurHome connection).";
const BAD_AFTER = "after must be a whole number, 0 or more.";
const BAD_LIMIT = `limit must be a whole number from 1 to ${HANDOFF_MAX_LIMIT}.`;
const NO_CONNECTION = "Make a token first: the start date belongs to the OurHome connection.";

const COUNT = /^\d{1,15}$/;

/** A real day, "2026-11-01". */
export function isDay(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const time = Date.parse(`${text}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === text;
}

const dayField = z.string({ error: "Choose a start date." }).refine(isDay, "Choose a real day for the start date.");
const tokenSchema = z.object({ startDate: dayField.optional() }, { error: MESSAGES.badShape });
const updateSchema = z.object({ startDate: dayField }, { error: MESSAGES.badShape });

const BAD_CHANGES = `Send "changes": a list of 1 to ${HANDOFF_MAX_CHANGES} changes, each with "messageId", "change" ("paid" or "removed") and "at" (a full ISO time).`;

/** A full ISO time with a date and a time of day, "2026-11-03T15:20:00.000Z". */
function isIsoTime(text: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/.test(text) && !Number.isNaN(Date.parse(text)) && isDay(text.slice(0, 10));
}

const changesSchema = z.object(
  {
    changes: z
      .array(
        z.object(
          {
            messageId: z.string({ error: BAD_CHANGES }).min(1, BAD_CHANGES).max(OURHOME_LIMITS.messageId, BAD_CHANGES),
            change: z.enum(["paid", "removed"], { error: BAD_CHANGES }),
            at: z.string({ error: BAD_CHANGES }).refine(isIsoTime, BAD_CHANGES),
          },
          { error: BAD_CHANGES },
        ),
        { error: BAD_CHANGES },
      )
      .min(1, BAD_CHANGES)
      .max(HANDOFF_MAX_CHANGES, BAD_CHANGES),
  },
  { error: BAD_CHANGES },
);

/** Whether this email is a payment (its pairing decides what it references). */
const isPayment = (email: HouseholdEmail) => email.item.payment?.role === "payment";

/** Brings the household's offers up to date with its emails. Nothing happens without a live token. */
export async function refreshOffers(deps: HandoffDeps, householdId: number): Promise<void> {
  if (liveStartDate(deps.db, householdId) === null) return;
  // Oldest first, so the numbers follow the emails' age.
  const emails = (await readHouseholdEmails(deps, householdId)).reverse();
  // A locked payment whose bill's email cannot be read is left as it was, like an email that is missing.
  const kept = emails.filter((email) => !(email.pairing?.locked && email.pairing.billMissing));
  const decided = (list: HouseholdEmail[]) => list.map(({ item, decision }) => ({ captureId: item.id, decision }));
  const now = deps.now();
  // Bills (and everything else) first, then payments: a payment that goes always gets a higher number than its bill.
  applyDecisions(deps.db, householdId, decided(kept.filter((email) => !isPayment(email))), now);
  applyDecisions(deps.db, householdId, decided(kept.filter(isPayment)), now);
  // A payment offered as ready never changes its bill again.
  const sent = kept.filter((email) => isPayment(email) && email.decision.state === "goes" && !email.pairing?.locked);
  lockPairings(deps.db, householdId, sent.map((email) => ({ paymentId: email.item.id, billId: email.pairing?.billId ?? null })), now);
}

/** The household whose token came with the request, or an error reply. */
function tokenHousehold(c: Context<AppEnv>, db: Database): number | Response {
  const header = c.req.header("Authorization") ?? "";
  const token = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
  const householdId = token ? householdForToken(db, token) : null;
  if (householdId !== null) return householdId;
  c.header("WWW-Authenticate", 'Bearer realm="OurHomeInbox"');
  return apiError(c, 401, token ? BAD_TOKEN : NO_TOKEN);
}

/** A query value as a count, its default when left out, or null when it is not one. */
function count(text: string | undefined, fallback: number): number | null {
  if (text === undefined || text === "") return fallback;
  return COUNT.test(text) ? Number(text) : null;
}

export function handoffRoutes(deps: HandoffDeps): Hono<AppEnv> {
  const { db, now } = deps;
  const app = new Hono<AppEnv>();

  // --- For OurHome, with its token ---

  app.get("/handoff/hello", async (c) => {
    const householdId = tokenHousehold(c, db);
    if (householdId instanceof Response) return householdId;
    await refreshOffers(deps, householdId);
    noteAsked(db, householdId, 0, now());
    const body: HandoffHelloResponse = {
      household: db.get<{ name: string }>("SELECT name FROM households WHERE id = ?", householdId)?.name ?? "",
      newest: newestNumber(db, householdId),
      startDate: connectionRow(db, householdId)!.start_date,
    };
    return c.json(body);
  });

  app.get("/handoff/documents", async (c) => {
    const householdId = tokenHousehold(c, db);
    if (householdId instanceof Response) return householdId;
    const after = count(c.req.query("after"), 0);
    if (after === null) return apiError(c, 400, BAD_AFTER);
    const limit = count(c.req.query("limit"), HANDOFF_DEFAULT_LIMIT);
    if (limit === null || limit < 1 || limit > HANDOFF_MAX_LIMIT) return apiError(c, 400, BAD_LIMIT);

    await refreshOffers(deps, householdId);
    // Asking after n says OurHome has handled everything up to n (never more than was offered).
    noteAsked(db, householdId, Math.min(after, newestNumber(db, householdId)), now());
    const { entries, more } = offersAfter(db, householdId, after, limit);
    const body: HandoffDocumentsResponse = { documents: entries, next: entries.at(-1)?.number ?? after, more };
    return c.json(body);
  });

  // Contract v2: OurHome reports what a person did to an email bill there. All
  // or nothing: a body that breaks the rules keeps nothing. Unknown messageIds
  // are counted and dropped; the same report again changes nothing.
  app.post("/handoff/changes", async (c) => {
    const householdId = tokenHousehold(c, db);
    if (householdId instanceof Response) return householdId;
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return apiError(c, 400, MESSAGES.badJson);
    }
    const parsed = changesSchema.safeParse(raw);
    if (!parsed.success) return apiError(c, 400, parsed.error.issues[0]?.message ?? BAD_CHANGES);
    const body: HandoffChangesResponse = recordChanges(db, householdId, parsed.data.changes, now());
    noteAsked(db, householdId, 0, now());
    return c.json(body);
  });

  // --- For the household, signed in ---

  app.get("/ourhome", (c) => c.json(connectionInfo(db, householdOf(c))));

  app.post("/ourhome/token", jsonBody(tokenSchema), (c) => {
    const householdId = householdOf(c);
    const token = createToken(db, householdId, (c.var.user as SessionUser).id, c.req.valid("json").startDate, now());
    const body: OurHomeTokenResponse = { token, connection: connectionInfo(db, householdId) };
    return c.json(body, 201);
  });

  app.delete("/ourhome/token", (c) => {
    const householdId = householdOf(c);
    revokeToken(db, householdId);
    return c.json(connectionInfo(db, householdId));
  });

  app.put("/ourhome", jsonBody(updateSchema), (c) => {
    const householdId = householdOf(c);
    if (!setStartDate(db, householdId, c.req.valid("json").startDate)) return apiError(c, 409, NO_CONNECTION);
    return c.json(connectionInfo(db, householdId));
  });

  return app;
}
