// Review: a person marks the household's emails "checked" (someone looked at
// it and what was picked out of it) or "not a bill" (never sent to OurHome),
// or clears the mark so the email needs a look again:
//   PUT /api/captures/review   mark or clear one or more emails
//
// Scoped to the signed-in person's household; only emails in its own
// mailboxes can be marked. Any member can mark, as with tags. An email is
// named by its capture id, so its mark stays with it while its mailbox is
// removed and comes back when the mailbox is restored.

import { Hono } from "hono";
import { z } from "zod";
import type { CaptureReview, CaptureReviewResponse, SessionUser } from "../shared/api.js";
import { MAX_REVIEWED_AT_ONCE, REVIEW_STATES, type ReviewState } from "../shared/review.js";
import type { CaptureStore } from "../store.js";
import type { Database } from "./db.js";
import { apiError, householdOf, jsonBody, MESSAGES, type AppEnv } from "./http.js";
import { isCapturedIn } from "./mail.js";
import type { Mailboxes } from "./mailboxes.js";

export interface ReviewDeps {
  db: Database;
  store: CaptureStore;
  mailboxes: Mailboxes;
  now: () => Date;
}

const EMAIL_NOT_FOUND = "One of those emails was not found. It may be in a mailbox that is no longer set up. Nothing was changed.";

const reviewSchema = z.object(
  {
    captureIds: z
      .array(z.string({ error: MESSAGES.badShape }).max(300, EMAIL_NOT_FOUND), { error: MESSAGES.badShape })
      .min(1, "Choose at least one email.")
      .transform((ids) => [...new Set(ids)])
      .refine((ids) => ids.length <= MAX_REVIEWED_AT_ONCE, `Mark at most ${MAX_REVIEWED_AT_ONCE} emails at once.`),
    // Required, so a body that forgets it never clears marks by accident.
    state: z.enum(REVIEW_STATES, { error: MESSAGES.badShape }).nullable(),
  },
  { error: MESSAGES.badShape },
);

interface ReviewRow {
  capture_id: string;
  state: ReviewState;
  reviewed_at: string;
  name: string | null;
}

const SELECT_REVIEWS = `SELECT r.capture_id, r.state, r.reviewed_at, u.name FROM capture_reviews r
  LEFT JOIN users u ON u.id = r.reviewed_by WHERE r.household_id = ?`;

function reviewOf(row: ReviewRow): CaptureReview {
  return { state: row.state, by: row.name, at: row.reviewed_at };
}

/** The household's marks on its emails, by capture id. */
export function captureReviews(db: Database, householdId: number): Map<string, CaptureReview> {
  return new Map(db.all<ReviewRow>(SELECT_REVIEWS, householdId).map((row) => [row.capture_id, reviewOf(row)]));
}

/** The household's mark on one email, or null. */
export function reviewOn(db: Database, householdId: number, captureId: string): CaptureReview | null {
  const row = db.get<ReviewRow>(`${SELECT_REVIEWS} AND r.capture_id = ?`, householdId, captureId);
  return row ? reviewOf(row) : null;
}

export function reviewRoutes(deps: ReviewDeps): Hono<AppEnv> {
  const { db, store, mailboxes, now } = deps;
  const app = new Hono<AppEnv>();

  app.put("/captures/review", jsonBody(reviewSchema), (c) => {
    const householdId = householdOf(c);
    const userId = (c.var.user as SessionUser).id;
    const { captureIds, state } = c.req.valid("json");
    const slugs = new Set(mailboxes.places(householdId).keys());
    if (!captureIds.every((id) => isCapturedIn(store, id, slugs))) return apiError(c, 404, EMAIL_NOT_FOUND);
    const stamp = now().toISOString();

    db.transaction(() => {
      for (const captureId of captureIds) {
        if (state === null) {
          db.run("DELETE FROM capture_reviews WHERE household_id = ? AND capture_id = ?", householdId, captureId);
        } else {
          // Marked the same way already: who marked it first, and when, stay.
          db.run(
            `INSERT INTO capture_reviews (household_id, capture_id, state, reviewed_by, reviewed_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (household_id, capture_id) DO UPDATE
             SET state = excluded.state, reviewed_by = excluded.reviewed_by, reviewed_at = excluded.reviewed_at
             WHERE capture_reviews.state <> excluded.state`,
            householdId,
            captureId,
            state,
            userId,
            stamp,
          );
        }
      }
    });

    const body: CaptureReviewResponse = { captures: captureIds.map((id) => ({ id, review: reviewOn(db, householdId, id) })) };
    return c.json(body);
  });

  return app;
}
