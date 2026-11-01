// GET /api/status: whether OurHomeInbox is working, for the Status page.
// When mail is read, how each of the household's mailboxes last went, what
// its emails' invoice links gave, and the recent warnings and errors from the
// log. A mail reader that fails quietly is worse than none.

import { Hono, type Context } from "hono";
import { recentProblems } from "../log.js";
import type { CheckingState, InvoiceActivity, StatusResponse } from "../shared/api.js";
import { INVOICE_OUTCOMES, type InvoiceOutcome } from "../shared/invoice.js";
import type { CaptureStore } from "../store.js";
import { householdOf, type AppEnv } from "./http.js";
import { MAX_ATTEMPTS } from "./invoices.js";
import { eachCapture } from "./mail.js";
import type { Mailboxes } from "./mailboxes.js";

/** How many of the latest invoice link tries are listed. */
export const RECENT_INVOICES = 15;

export interface StatusDeps {
  mailboxes: Mailboxes;
  store: CaptureStore;
  checking: { state(): CheckingState };
  version: string;
  startedAt: Date;
}

export function statusRoutes(deps: StatusDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/status", async (c: Context<AppEnv>) => {
    const householdId = householdOf(c);
    const counts = Object.fromEntries(INVOICE_OUTCOMES.map((outcome) => [outcome, 0])) as Record<InvoiceOutcome, number>;
    let retrying = 0;
    const tried: InvoiceActivity[] = [];
    for await (const stored of eachCapture(deps.mailboxes.places(householdId).values(), deps.store)) {
      const record = stored.invoice;
      if (!record) continue;
      const again = record.outcome === "failed" && record.attempts < MAX_ATTEMPTS;
      if (again) retrying++;
      else counts[record.outcome]++;
      const first = stored.capture.from[0];
      tried.push({
        captureId: stored.id,
        subject: stored.capture.subject,
        sender: first ? first.name.trim() || first.address : "",
        outcome: record.outcome,
        reason: record.reason,
        triedAt: record.triedAt,
        retrying: again,
      });
    }
    tried.sort((a, b) => (a.triedAt < b.triedAt ? 1 : a.triedAt > b.triedAt ? -1 : a.captureId < b.captureId ? -1 : 1));

    const body: StatusResponse = {
      version: deps.version,
      startedAt: deps.startedAt.toISOString(),
      checking: deps.checking.state(),
      mailboxes: deps.mailboxes.list(householdId),
      invoices: { counts, retrying, recent: tried.slice(0, RECENT_INVOICES) },
      // For everyone: an install holds one household (see StatusResponse.problems).
      problems: recentProblems(),
      canEdit: true,
    };
    return c.json(body);
  });

  return app;
}
