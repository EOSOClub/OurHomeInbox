// Biller rules over the API: Fix's choices on an email, saving and removing a
// rule, and the rule showing at once on every email from that biller.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiError, BillerRulesResponse, CaptureDetailResponse, CaptureListResponse, FieldChoicesResponse } from "../../src/shared/api.js";
import { call, json, makeServer, rawEmail, saveEmail, setUp, type TestServer } from "./helpers.js";

let server: TestServer;
let cookie: string;

beforeEach(async () => {
  server = makeServer();
  cookie = await setUp(server.app);
});

afterEach(() => {
  server.close();
});

const get = (path: string) => call(server.app, path, { cookie });
const put = (path: string, body: unknown) => call(server.app, path, { method: "PUT", cookie, body });
const del = (path: string) => call(server.app, path, { method: "DELETE", cookie });

const cells = (...pairs: string[]) => `<table>${pairs.map((p) => `<tr><td>${p}</td></tr>`).join("")}</table>`;

async function addWaterBiller(): Promise<number> {
  const res = await call(server.app, "/api/billers", { method: "POST", cookie, body: { name: "Water Co", kind: "bill", senders: ["water.example"] } });
  return ((await res.json()) as { id: number }).id;
}

/** Three emails from Water Co: two with Current Charges, one without. */
async function saveBills() {
  await saveEmail(server.store, rawEmail({ subject: "Your bill", html: cells("Payment Amount: $194.26", "Current Charges: $202.63") }), { uid: 1 });
  await saveEmail(server.store, rawEmail({ subject: "Your bill", html: cells("Payment Amount: $50.00", "Current Charges: $55.00") }), { uid: 2 });
  await saveEmail(server.store, rawEmail({ subject: "Your bill", html: cells("Payment Amount: $70.00") }), { uid: 3 });
}

const EMAIL = "/api/captures/proton-bills/1700000000/1";

describe("Fix's choices", () => {
  it("lists each amount in the email, with how many other emails a rule would change", async () => {
    const billerId = await addWaterBiller();
    await saveBills();
    const res = await get(`${EMAIL}/choices/amount`);
    expect(res.status).toBe(200);
    const body = await json<FieldChoicesResponse>(res);
    expect(body).toMatchObject({ field: "amount", biller: { id: billerId, name: "Water Co" }, rule: null, otherEmails: 2 });
    expect(body.choices.map((c) => [c.label, c.value.value, c.current, c.changes])).toEqual([
      ["Payment Amount", "194.26", true, 0],
      ["Current Charges", "202.63", false, 1],
    ]);
  });

  it("needs the email's sender to belong to a biller", async () => {
    await saveBills();
    const res = await get(`${EMAIL}/choices/amount`);
    expect(res.status).toBe(409);
    expect((await json<ApiError>(res)).error).toMatch(/billers first/);
  });

  it("refuses a field the reader does not pick out, and an email that is not captured", async () => {
    await addWaterBiller();
    await saveBills();
    expect((await get(`${EMAIL}/choices/total`)).status).toBe(404);
    expect((await get(`${EMAIL}/choices/constructor`)).status).toBe(404);
    expect((await get("/api/captures/proton-bills/1700000000/9/choices/amount")).status).toBe(404);
  });
});

describe("saving and removing a rule", () => {
  it("applies to every email from the biller at once, in the list and on each email", async () => {
    const billerId = await addWaterBiller();
    await saveBills();
    const amounts = async () => (await json<CaptureListResponse>(await get("/api/captures"))).captures.map((c) => [c.uid, c.picked.amount]);
    expect(await amounts()).toEqual([
      [3, "70.00"],
      [2, "50.00"],
      [1, "194.26"],
    ]);

    expect((await put(`/api/billers/${billerId}/rules/amount`, { label: "  Current   Charges " })).status).toBe(204);
    expect(await amounts()).toEqual([
      [3, "70.00"],
      [2, "55.00"],
      [1, "202.63"],
    ]);
    const detail = await json<CaptureDetailResponse>(await get(EMAIL));
    expect(detail.extraction.fields.find((f) => f.field === "amount")).toMatchObject({ by: "rule", values: [{ value: "202.63" }] });
    const choices = await json<FieldChoicesResponse>(await get(`${EMAIL}/choices/amount`));
    expect(choices.rule).toEqual({ field: "amount", label: "Current Charges" });
    expect(choices.choices.find((c) => c.current)?.label).toBe("Current Charges");

    const rules = await json<BillerRulesResponse>(await get(`/api/billers/${billerId}/rules`));
    expect(rules).toEqual({
      rules: [{ field: "amount", label: "Current Charges", createdAt: "2026-10-29T12:00:00.000Z", usedOn: 2 }],
      emails: 3,
    });

    expect((await del(`/api/billers/${billerId}/rules/amount`)).status).toBe(204);
    expect(await amounts()).toEqual([
      [3, "70.00"],
      [2, "50.00"],
      [1, "194.26"],
    ]);
    expect(await json<BillerRulesResponse>(await get(`/api/billers/${billerId}/rules`))).toEqual({ rules: [], emails: 3 });
    expect((await del(`/api/billers/${billerId}/rules/amount`)).status).toBe(404);
  });

  it("replaces the field's rule rather than adding a second", async () => {
    const billerId = await addWaterBiller();
    await put(`/api/billers/${billerId}/rules/amount`, { label: "Current Charges" });
    server.clock.now = new Date("2026-10-30T08:00:00Z");
    await put(`/api/billers/${billerId}/rules/amount`, { label: "Payment Amount" });
    await put(`/api/billers/${billerId}/rules/dueDate`, { label: "Pay Before" });
    const { rules } = await json<BillerRulesResponse>(await get(`/api/billers/${billerId}/rules`));
    expect(rules.map((r) => [r.field, r.label, r.createdAt])).toEqual([
      ["amount", "Payment Amount", "2026-10-30T08:00:00.000Z"],
      ["dueDate", "Pay Before", "2026-10-30T08:00:00.000Z"],
    ]);
  });

  it.each([
    [{ label: "" }, /Choose the words/],
    [{ label: "   " }, /Choose the words/],
    [{ label: "x".repeat(61) }, /under 60/],
    [{ label: "1234" }, /include letters/],
    [{ label: "Total\u0000" }, /include letters/],
    [{}, /Choose the words/],
    [{ label: 5 }, /Choose the words/],
  ])("refuses the label in %j", async (body, message) => {
    const billerId = await addWaterBiller();
    const res = await put(`/api/billers/${billerId}/rules/amount`, body);
    expect(res.status).toBe(400);
    expect((await json<ApiError>(res)).error).toMatch(message);
  });

  it("refuses a field the reader does not pick out", async () => {
    const billerId = await addWaterBiller();
    expect((await put(`/api/billers/${billerId}/rules/total`, { label: "Total" })).status).toBe(404);
    expect((await del(`/api/billers/${billerId}/rules/total`)).status).toBe(404);
  });

  it("goes with its biller when the biller is deleted", async () => {
    const billerId = await addWaterBiller();
    await put(`/api/billers/${billerId}/rules/amount`, { label: "Current Charges" });
    await del(`/api/billers/${billerId}`);
    expect(server.db.get<{ n: number }>("SELECT count(*) AS n FROM biller_rules")?.n).toBe(0);
    expect((await get(`/api/billers/${billerId}/rules`)).status).toBe(404);
  });

  it("never reaches another household's biller", async () => {
    const stamp = "2026-10-29T00:00:00.000Z";
    const household = server.db.run("INSERT INTO households (name, created_at) VALUES ('The Joneses', ?)", stamp).lastInsertRowid;
    const theirs = server.db.run(
      "INSERT INTO billers (household_id, name, kind, created_at, updated_at) VALUES (?, 'Their Water', 'bill', ?, ?)",
      household,
      stamp,
      stamp,
    ).lastInsertRowid;
    server.db.run(
      "INSERT INTO biller_rules (biller_id, household_id, field, label, created_at) VALUES (?, ?, 'amount', 'Total', ?)",
      theirs,
      household,
      stamp,
    );
    expect((await get(`/api/billers/${theirs}/rules`)).status).toBe(404);
    expect((await put(`/api/billers/${theirs}/rules/amount`, { label: "Mine now" })).status).toBe(404);
    expect((await del(`/api/billers/${theirs}/rules/amount`)).status).toBe(404);
    expect(server.db.get<{ label: string }>("SELECT label FROM biller_rules WHERE biller_id = ?", theirs)?.label).toBe("Total");
  });
});
