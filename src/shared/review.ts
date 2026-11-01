// Review: a person marks a household's email "checked" (someone looked at it
// and what was picked out of it) or "not a bill" (it is never sent to
// OurHome). An email with neither still needs attention. Shared by the server
// (which stores it) and the web app.

export const REVIEW_STATES = ["checked", "not-bill"] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

/** The most emails one change can mark or clear. */
export const MAX_REVIEWED_AT_ONCE = 500;
