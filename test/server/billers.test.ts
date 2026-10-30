import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiError, Biller, BillerListResponse } from "../../src/shared/api.js";
import { call, json, makeServer, setUp, type TestServer } from "./helpers.js";

let server: TestServer;
let cookie: string;

beforeEach(async () => {
  server = makeServer();
  cookie = await setUp(server.app);
});

afterEach(() => {
  server.close();
});

const WATER = { name: "City Water", kind: "bill", senders: ["billing@citywater.example"], notes: "" };

async function create(body: unknown): Promise<Response> {
  return call(server.app, "/api/billers", { method: "POST", body, cookie });
}

async function created(body: unknown): Promise<Biller> {
  const res = await create(body);
  if (res.status !== 201) throw new Error(`create failed: ${res.status} ${await res.text()}`);
  return json<Biller>(res);
}

async function errorOf(res: Response): Promise<string> {
  return (await json<ApiError>(res)).error;
}

/** Adds a second household with one biller, straight into the database. */
function otherHouseholdBiller(): number {
  const stamp = "2026-10-29T00:00:00.000Z";
  const household = server.db.run("INSERT INTO households (name, created_at) VALUES ('The Joneses', ?)", stamp).lastInsertRowid;
  const biller = server.db.run(
    "INSERT INTO billers (household_id, name, kind, created_at, updated_at) VALUES (?, 'Their Power', 'bill', ?, ?)",
    household,
    stamp,
    stamp,
  ).lastInsertRowid;
  server.db.run(
    "INSERT INTO biller_senders (biller_id, household_id, sender, position) VALUES (?, ?, 'power.example', 0)",
    biller,
    household,
  );
  return biller;
}

describe("billers", () => {
  it("needs a signed-in person", async () => {
    expect((await call(server.app, "/api/billers")).status).toBe(401);
    expect((await call(server.app, "/api/billers", { method: "POST", body: WATER })).status).toBe(401);
  });

  it("starts with none", async () => {
    const res = await call(server.app, "/api/billers", { cookie });
    expect(res.status).toBe(200);
    expect(await json<BillerListResponse>(res)).toEqual({ billers: [] });
  });

  it("adds a biller, cleaning up its senders", async () => {
    const biller = await created({
      name: "  City Water ",
      kind: "bill",
      senders: [" Billing@CityWater.example ", "@CityWater.example", "City Water <billing@citywater.example>", "", "mailto:help@citywater.example"],
      notes: " Paid on the 1st. ",
    });
    expect(biller).toEqual({
      id: expect.any(Number),
      name: "City Water",
      kind: "bill",
      senders: ["billing@citywater.example", "citywater.example", "help@citywater.example"],
      notes: "Paid on the 1st.",
      createdAt: "2026-10-29T12:00:00.000Z",
      updatedAt: "2026-10-29T12:00:00.000Z",
    });
    const one = await call(server.app, `/api/billers/${biller.id}`, { cookie });
    expect(await json<Biller>(one)).toEqual(biller);
  });

  it("lists billers by name, ignoring capitals", async () => {
    await created({ ...WATER, name: "water", senders: [] });
    await created({ name: "Netflix", kind: "subscription", senders: ["netflix.example"] });
    await created({ name: "Acme Power", kind: "bill", senders: ["acme.example"] });
    const { billers } = await json<BillerListResponse>(await call(server.app, "/api/billers", { cookie }));
    expect(billers.map((b) => b.name)).toEqual(["Acme Power", "Netflix", "water"]);
    expect(billers.find((b) => b.name === "Netflix")?.senders).toEqual(["netflix.example"]);
  });

  it("notes are optional", async () => {
    const biller = await created({ name: "Netflix", kind: "subscription", senders: [] });
    expect(biller.notes).toBe("");
    expect(biller.senders).toEqual([]);
  });

  it("refuses what it cannot use, saying what is wrong", async () => {
    const cases: Array<[unknown, RegExp]> = [
      [{ ...WATER, name: "  " }, /Enter the biller's name/],
      [{ ...WATER, name: "x".repeat(201) }, /under 200 characters/],
      [{ ...WATER, kind: "utility" }, /bill or a subscription/],
      [{ ...WATER, senders: ["not an address"] }, /"not an address" is not an email address or domain/],
      [{ ...WATER, senders: ["billing@"] }, /not an email address or domain/],
      [{ ...WATER, senders: ["localhost"] }, /not an email address or domain/],
      [{ ...WATER, senders: "billing@citywater.example" }, /as a list/],
      [{ ...WATER, senders: Array.from({ length: 51 }, (_, i) => `a${i}.example`) }, /at most 50/],
      [{ ...WATER, notes: "x".repeat(2001) }, /under 2000 characters/],
      [{ name: "City Water" }, /bill or a subscription|not in the right form/],
    ];
    for (const [body, message] of cases) {
      const res = await create(body);
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(await errorOf(res)).toMatch(message);
    }
    const { billers } = await json<BillerListResponse>(await call(server.app, "/api/billers", { cookie }));
    expect(billers).toEqual([]);
  });

  it("accepts addresses and domains in other scripts", async () => {
    const biller = await created({ ...WATER, senders: ["factures@électricité.example", "élec.example"] });
    expect(biller.senders).toEqual(["factures@électricité.example", "élec.example"]);
  });

  it("refuses a second biller with the same name", async () => {
    await created(WATER);
    const res = await create({ ...WATER, name: "CITY WATER", senders: [] });
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe("There is already a biller called City Water.");
  });

  it("refuses a sender that already belongs to another biller", async () => {
    await created(WATER);
    const res = await create({ name: "Water Two", kind: "bill", senders: ["BILLING@citywater.example"] });
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe(
      "billing@citywater.example is already listed for City Water. An address can belong to one biller only.",
    );
  });

  it("lets a domain and an address under it belong to different billers", async () => {
    await created({ name: "Amazon", kind: "subscription", senders: ["amazon.example"] });
    const prime = await created({ name: "Prime Video", kind: "subscription", senders: ["video@amazon.example"] });
    expect(prime.senders).toEqual(["video@amazon.example"]);
  });

  it("changes a biller, replacing its senders in the order given", async () => {
    const biller = await created({ ...WATER, senders: ["a.example", "b.example"] });
    server.clock.now = new Date("2026-10-30T08:00:00Z");
    const res = await call(server.app, `/api/billers/${biller.id}`, {
      method: "PUT",
      cookie,
      body: { name: "City Water Dept", kind: "bill", senders: ["c.example", "a.example"], notes: "New" },
    });
    expect(res.status).toBe(200);
    expect(await json<Biller>(res)).toEqual({
      ...biller,
      name: "City Water Dept",
      senders: ["c.example", "a.example"],
      notes: "New",
      updatedAt: "2026-10-30T08:00:00.000Z",
    });
  });

  it("lets a biller keep its own name and senders when changed", async () => {
    const biller = await created(WATER);
    const res = await call(server.app, `/api/billers/${biller.id}`, {
      method: "PUT",
      cookie,
      body: { ...WATER, name: "city water", kind: "subscription" },
    });
    expect(res.status).toBe(200);
    expect((await json<Biller>(res)).kind).toBe("subscription");
  });

  it("does not change a biller when the change is refused", async () => {
    const water = await created(WATER);
    const power = await created({ name: "Acme Power", kind: "bill", senders: ["acme.example"] });
    const res = await call(server.app, `/api/billers/${power.id}`, {
      method: "PUT",
      cookie,
      body: { name: "Acme Power 2", kind: "bill", senders: ["new.example", "billing@citywater.example"] },
    });
    expect(res.status).toBe(409);
    const after = await json<Biller>(await call(server.app, `/api/billers/${power.id}`, { cookie }));
    expect(after).toEqual(power);
    expect((await json<Biller>(await call(server.app, `/api/billers/${water.id}`, { cookie }))).senders).toEqual(WATER.senders);
  });

  it("deletes a biller, freeing its senders", async () => {
    const biller = await created(WATER);
    const res = await call(server.app, `/api/billers/${biller.id}`, { method: "DELETE", cookie });
    expect(res.status).toBe(204);
    expect((await call(server.app, `/api/billers/${biller.id}`, { cookie })).status).toBe(404);
    expect((await call(server.app, `/api/billers/${biller.id}`, { method: "DELETE", cookie })).status).toBe(404);
    expect((await create({ ...WATER, name: "Water again" })).status).toBe(201);
  });

  it("answers not found for an id that names nothing", async () => {
    for (const id of ["999", "0", "abc", "1.5", "99999999999999999999"]) {
      const res = await call(server.app, `/api/billers/${id}`, { cookie });
      expect(res.status, id).toBe(404);
      expect(await errorOf(res)).toMatch(/That biller was not found/);
      expect((await call(server.app, `/api/billers/${id}`, { method: "PUT", cookie, body: WATER })).status, id).toBe(404);
    }
  });

  it("keeps each household's billers to itself", async () => {
    const theirs = otherHouseholdBiller();
    const { billers } = await json<BillerListResponse>(await call(server.app, "/api/billers", { cookie }));
    expect(billers).toEqual([]);
    expect((await call(server.app, `/api/billers/${theirs}`, { cookie })).status).toBe(404);
    expect((await call(server.app, `/api/billers/${theirs}`, { method: "PUT", cookie, body: WATER })).status).toBe(404);
    expect((await call(server.app, `/api/billers/${theirs}`, { method: "DELETE", cookie })).status).toBe(404);
    expect(server.db.get<{ name: string }>("SELECT name FROM billers WHERE id = ?", theirs)?.name).toBe("Their Power");
    // Names and senders only clash within a household.
    expect((await create({ name: "Their Power", kind: "bill", senders: ["power.example"] })).status).toBe(201);
  });

  it("blocks changes sent from another website", async () => {
    const res = await call(server.app, "/api/billers", {
      method: "POST",
      cookie,
      body: WATER,
      headers: { Origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
  });
});
