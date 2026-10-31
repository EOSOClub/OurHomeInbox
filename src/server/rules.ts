// A biller's rules, saved with Fix on one of its emails: in that biller's
// emails, a field is the value after the label the person chose.
//   GET    /api/billers/:id/rules          its rules, with how many emails each is used on
//   PUT    /api/billers/:id/rules/:field   save the rule for one field, replacing any
//   DELETE /api/billers/:id/rules/:field   remove it, so the built-in reader takes over again
//
// Scoped to the household like billers: another household's biller is "not
// found". Rules are applied when an email is read (captures.ts), never
// stored on the email, so a change shows on every email at once.

import { Hono, type Context } from "hono";
import { z } from "zod";
import type { BillerRuleItem, BillerRulesResponse } from "../shared/api.js";
import { FIELDS, MAX_RULE_LABEL, type BillerRule, type FieldName } from "../shared/extraction.js";
import type { CaptureStore } from "../store.js";
import { billerId, listBillers, NOT_FOUND as BILLER_NOT_FOUND } from "./billers.js";
import type { Database } from "./db.js";
import { finish, PreparedEmail } from "./extraction.js";
import { apiError, householdOf, jsonBody, MESSAGES, type AppEnv } from "./http.js";
import { eachCapture } from "./mail.js";
import type { MailboxPlace, Mailboxes } from "./mailboxes.js";
import { BillerMatcher } from "./matching.js";

export interface RuleDeps {
  store: CaptureStore;
  db: Database;
  mailboxes: Mailboxes;
  now: () => Date;
}

const NO_SUCH_FIELD = "That is not a value OurHomeInbox picks out.";
const NO_SUCH_RULE = "That rule was not found. It may have been removed already.";

function isField(text: string): text is FieldName {
  return (FIELDS as readonly string[]).includes(text);
}

const ruleSchema = z.object(
  {
    label: z
      .string({ error: "Choose the words the value comes after." })
      .transform((label) => label.replace(/\s+/g, " ").trim())
      .refine((label) => label.length > 0, "Choose the words the value comes after.")
      .refine((label) => label.length <= MAX_RULE_LABEL, `Keep the words under ${MAX_RULE_LABEL} characters.`)
      .refine((label) => /\p{L}/u.test(label) && !/[\p{Cc}\p{Cf}]/u.test(label), "The words the value comes after must include letters."),
  },
  { error: MESSAGES.badShape },
);

interface RuleRow {
  biller_id: number;
  field: string;
  label: string;
  created_at: string;
}

/** Every biller's rules in a household, by biller id, in the order fields are shown. */
export function householdRules(db: Database, householdId: number): Map<number, BillerRule[]> {
  const byBiller = new Map<number, BillerRule[]>();
  const rows = db.all<RuleRow>("SELECT biller_id, field, label, created_at FROM biller_rules WHERE household_id = ?", householdId);
  for (const field of FIELDS) {
    for (const row of rows.filter((r) => r.field === field)) {
      const list = byBiller.get(row.biller_id);
      const rule: BillerRule = { field, label: row.label };
      if (list) list.push(rule);
      else byBiller.set(row.biller_id, [rule]);
    }
  }
  return byBiller;
}

/**
 * The emails from one of the household's billers, in the household's
 * mailboxes, read and ready to try rules on. `except` leaves out one email by its id.
 */
export async function billerEmails(
  mailboxes: Iterable<MailboxPlace>,
  store: CaptureStore,
  matcher: BillerMatcher,
  billerId: number,
  except: string | null = null,
): Promise<PreparedEmail[]> {
  const emails: PreparedEmail[] = [];
  for await (const stored of eachCapture(mailboxes, store)) {
    if (stored.id !== except && matcher.match(stored.capture.from)?.id === billerId) {
      emails.push(new PreparedEmail(stored.capture, stored.invoice?.text ?? null));
    }
  }
  return emails;
}

/** The biller's id when it is one of this household's, else null. */
function ownBiller(c: Context<AppEnv>, db: Database): number | null {
  const id = billerId(c);
  if (id === null || !db.get("SELECT 1 FROM billers WHERE id = ? AND household_id = ?", id, householdOf(c))) return null;
  return id;
}

export function ruleRoutes(deps: RuleDeps): Hono<AppEnv> {
  const { db, now } = deps;
  const app = new Hono<AppEnv>();

  app.get("/billers/:id/rules", async (c) => {
    const id = ownBiller(c, db);
    if (id === null) return apiError(c, 404, BILLER_NOT_FOUND);
    const householdId = householdOf(c);
    const rules = householdRules(db, householdId).get(id) ?? [];
    const created = new Map(
      db.all<RuleRow>("SELECT field, created_at FROM biller_rules WHERE biller_id = ?", id).map((r) => [r.field, r.created_at]),
    );
    const places = deps.mailboxes.places(householdId).values();
    const emails = await billerEmails(places, deps.store, new BillerMatcher(listBillers(db, householdId)), id);
    const usedOn = new Map<FieldName, number>();
    for (const email of emails) {
      for (const field of finish(email, rules).fields) {
        if (field.by === "rule") usedOn.set(field.field, (usedOn.get(field.field) ?? 0) + 1);
      }
    }
    const items: BillerRuleItem[] = rules.map((rule) => ({
      ...rule,
      createdAt: created.get(rule.field) ?? "",
      usedOn: usedOn.get(rule.field) ?? 0,
    }));
    const body: BillerRulesResponse = { rules: items, emails: emails.length };
    return c.json(body);
  });

  app.put("/billers/:id/rules/:field", jsonBody(ruleSchema), (c) => {
    const field = c.req.param("field");
    if (!isField(field)) return apiError(c, 404, NO_SUCH_FIELD);
    const householdId = householdOf(c);
    const { label } = c.req.valid("json");
    const saved = db.transaction(() => {
      const id = ownBiller(c, db);
      if (id === null) return false;
      db.run(
        `INSERT INTO biller_rules (biller_id, household_id, field, label, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (biller_id, field) DO UPDATE SET label = excluded.label, created_at = excluded.created_at`,
        id,
        householdId,
        field,
        label,
        now().toISOString(),
      );
      return true;
    });
    if (!saved) return apiError(c, 404, BILLER_NOT_FOUND);
    return c.body(null, 204);
  });

  app.delete("/billers/:id/rules/:field", (c) => {
    const field = c.req.param("field");
    if (!isField(field)) return apiError(c, 404, NO_SUCH_FIELD);
    const id = ownBiller(c, db);
    if (id === null) return apiError(c, 404, BILLER_NOT_FOUND);
    const removed = db.run("DELETE FROM biller_rules WHERE biller_id = ? AND field = ?", id, field).changes;
    if (removed === 0) return apiError(c, 404, NO_SUCH_RULE);
    return c.body(null, 204);
  });

  return app;
}
