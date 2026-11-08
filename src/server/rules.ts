// A biller's rules, saved with Fix on one of its emails: in that biller's
// emails, a field is the value after the label the person chose. A rule is
// used always (ahead of the built-in reader; one per field), or only in
// emails where nothing else gives the field (owner, 2026-11-08; any number
// per field, tried in the order saved). Xcel's payments keep their "always"
// amount rule, and a reminder's "Past Due Balance" is added beside it,
// filling in the amount only where nothing else finds one.
//   GET    /api/billers/:id/rules          its rules, with how many emails each is used on
//   PUT    /api/billers/:id/rules/:field   save a rule for one field ({ label, when }): an "always" one
//                                          replaces the field's "always" one; any rule on the same words is replaced
//   DELETE /api/billers/:id/rules/:field[?label=...]   remove the field's rules, or only the one on those words
//
// Scoped to the household like billers: another household's biller is "not
// found". Rules are applied when an email is read (captures.ts), never
// stored on the email, so a change shows on every email at once. Saving or
// removing one breaks the biller's run toward Send automatically (handoff/trust.ts).

import { Hono, type Context } from "hono";
import { z } from "zod";
import type { BillerRuleItem, BillerRulesResponse } from "../shared/api.js";
import { FIELDS, MAX_RULE_LABEL, RULE_WHEN, type BillerRule, type FieldName, type RuleWhen } from "../shared/extraction.js";
import type { CaptureStore } from "../store.js";
import { billerId, listBillers, NOT_FOUND as BILLER_NOT_FOUND } from "./billers.js";
import type { Database } from "./db.js";
import { finish, PreparedEmail } from "./extraction.js";
import { apiError, householdOf, jsonBody, MESSAGES, type AppEnv } from "./http.js";
import { eachCapture } from "./mail.js";
import type { MailboxPlace, Mailboxes } from "./mailboxes.js";
import { BillerMatcher } from "./matching.js";
import { breakRun } from "./handoff/trust.js";

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
    when: z.enum(RULE_WHEN, { error: MESSAGES.badShape }).default("always"),
  },
  { error: MESSAGES.badShape },
);

interface RuleRow {
  biller_id: number;
  field: string;
  label: string;
  use_when: RuleWhen;
  created_at: string;
}

/** Every biller's rules in a household, by biller id, in the order fields are shown. */
export function householdRules(db: Database, householdId: number): Map<number, BillerRule[]> {
  const byBiller = new Map<number, BillerRule[]>();
  // By id: a field's "missing" rules are tried in the order they were saved.
  const rows = db.all<RuleRow>("SELECT biller_id, field, label, use_when, created_at FROM biller_rules WHERE household_id = ? ORDER BY id", householdId);
  for (const field of FIELDS) {
    for (const row of rows.filter((r) => r.field === field)) {
      const list = byBiller.get(row.biller_id);
      const rule: BillerRule = { field, label: row.label, when: row.use_when };
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
    const key = (field: string, label: string) => `${field}|${label.toLowerCase()}`;
    const created = new Map(
      db.all<RuleRow>("SELECT field, label, created_at FROM biller_rules WHERE biller_id = ?", id).map((r) => [key(r.field, r.label), r.created_at]),
    );
    const places = deps.mailboxes.places(householdId).values();
    const emails = await billerEmails(places, deps.store, new BillerMatcher(listBillers(db, householdId)), id);
    // Which rule picked a field: the one on the words it was found after.
    const usedOn = new Map<string, number>();
    for (const email of emails) {
      for (const field of finish(email, rules).fields) {
        const label = field.values[0]?.label;
        if (field.by === "rule" && label !== undefined) usedOn.set(key(field.field, label), (usedOn.get(key(field.field, label)) ?? 0) + 1);
      }
    }
    const items: BillerRuleItem[] = rules.map((rule) => ({
      ...rule,
      createdAt: created.get(key(rule.field, rule.label)) ?? "",
      usedOn: usedOn.get(key(rule.field, rule.label)) ?? 0,
    }));
    const body: BillerRulesResponse = { rules: items, emails: emails.length };
    return c.json(body);
  });

  app.put("/billers/:id/rules/:field", jsonBody(ruleSchema), (c) => {
    const field = c.req.param("field");
    if (!isField(field)) return apiError(c, 404, NO_SUCH_FIELD);
    const householdId = householdOf(c);
    const { label, when } = c.req.valid("json");
    const saved = db.transaction(() => {
      const id = ownBiller(c, db);
      if (id === null) return false;
      // A rule on the same words is replaced (it may change the way it is used); an "always" one replaces the field's "always" one.
      db.run(
        "DELETE FROM biller_rules WHERE biller_id = ? AND field = ? AND (label = ? COLLATE NOCASE OR (? = 'always' AND use_when = 'always'))",
        id,
        field,
        label,
        when,
      );
      db.run(
        "INSERT INTO biller_rules (biller_id, household_id, field, label, use_when, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        id,
        householdId,
        field,
        label,
        when,
        now().toISOString(),
      );
      // A value needed fixing: the biller's run of clean checks starts again.
      breakRun(db, id);
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
    const label = c.req.query("label");
    const removed = db.transaction(() => {
      const changes =
        label === undefined
          ? db.run("DELETE FROM biller_rules WHERE biller_id = ? AND field = ?", id, field).changes
          : db.run("DELETE FROM biller_rules WHERE biller_id = ? AND field = ? AND label = ? COLLATE NOCASE", id, field, label.replace(/\s+/g, " ").trim()).changes;
      if (changes > 0) breakRun(db, id);
      return changes;
    });
    if (removed === 0) return apiError(c, 404, NO_SUCH_RULE);
    return c.body(null, 204);
  });

  return app;
}
