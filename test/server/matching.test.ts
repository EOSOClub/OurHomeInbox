import { describe, expect, it } from "vitest";
import { BillerMatcher } from "../../src/server/matching.js";
import type { Biller } from "../../src/shared/api.js";
import type { BillerKind } from "../../src/shared/billers.js";

let nextId = 1;
function biller(name: string, senders: string[], kind: BillerKind = "bill"): Biller {
  return { id: nextId++, name, kind, senders, notes: "", fetchInvoices: true, createdAt: "", updatedAt: "" };
}

const from = (address: string, name = "") => [{ name, address }];

const water = biller("City Water", ["citywater.example"]);
const waterAlerts = biller("Water Alerts", ["alerts.citywater.example"]);
const amazon = biller("Amazon", ["amazon.example"], "subscription");
const prime = biller("Prime Video", ["video@amazon.example"], "subscription");
const elec = biller("Électricité", ["élec.example", "factures@xn--lectricit-93aj.example"]);
const matcher = new BillerMatcher([water, waterAlerts, amazon, prime, elec]);

describe("BillerMatcher", () => {
  it("matches a domain and its subdomains", () => {
    expect(matcher.match(from("billing@citywater.example"))).toEqual({ id: water.id, name: "City Water", kind: "bill", matchedOn: "citywater.example" });
    expect(matcher.match(from("no-reply@mail.citywater.example"))?.name).toBe("City Water");
  });

  it("prefers the most specific domain", () => {
    expect(matcher.match(from("x@alerts.citywater.example"))?.name).toBe("Water Alerts");
    expect(matcher.match(from("x@deep.alerts.citywater.example"))?.name).toBe("Water Alerts");
  });

  it("prefers a full address over its domain", () => {
    expect(matcher.match(from("video@amazon.example"))).toMatchObject({ name: "Prime Video", matchedOn: "video@amazon.example" });
    expect(matcher.match(from("orders@amazon.example"))?.name).toBe("Amazon");
  });

  it("ignores capitals and spaces in the From address", () => {
    expect(matcher.match(from("  Video@Amazon.EXAMPLE "))?.name).toBe("Prime Video");
  });

  it("does not match a domain that only ends the same way", () => {
    expect(matcher.match(from("billing@notcitywater.example"))).toBeNull();
    expect(matcher.match(from("billing@citywater.example.evil"))).toBeNull();
  });

  it("treats a domain written in punycode and in its own script as the same", () => {
    expect(matcher.match(from("billing@xn--lec-9la.example"))?.name).toBe("Électricité");
    expect(matcher.match(from("factures@électricité.example"))).toMatchObject({ name: "Électricité", matchedOn: "factures@xn--lectricit-93aj.example" });
  });

  it("uses the first From address that has one", () => {
    expect(matcher.match([{ name: "Group", address: "" }, { name: "", address: "x@citywater.example" }])?.name).toBe("City Water");
  });

  it("matches nothing without an address or billers", () => {
    expect(matcher.match([])).toBeNull();
    expect(matcher.match(from("someone@else.example"))).toBeNull();
    expect(matcher.match(from("not-an-address"))).toBeNull();
    expect(new BillerMatcher([]).match(from("billing@citywater.example"))).toBeNull();
  });
});
