// Tests for the biller form's checks and the small helpers the biller pages use.

import { describe, expect, it } from "vitest";
import { addSenderPathFrom, checkBillerForm, newBillerPathFrom, sendersSummary, sendersWith, type BillerForm } from "./billers";

const good: BillerForm = { name: " City Water ", kind: "bill", senders: "Billing@CityWater.example\n@citywater.example\n", notes: " " };

describe("checkBillerForm", () => {
  it("turns a good form into the request, cleaned up", () => {
    expect(checkBillerForm(good)).toEqual({
      errors: {},
      input: { name: "City Water", kind: "bill", senders: ["billing@citywater.example", "citywater.example"], notes: "" },
    });
  });

  it("allows no senders yet", () => {
    expect(checkBillerForm({ ...good, senders: "" }).input?.senders).toEqual([]);
  });

  it("asks for a name and a kind", () => {
    const { errors, input } = checkBillerForm({ name: " ", kind: null, senders: "", notes: "" });
    expect(input).toBeNull();
    expect(errors).toEqual({ name: "Enter the biller's name.", kind: "Choose whether this is a bill or a subscription." });
  });

  it("names the first wrong sender and counts the rest", () => {
    expect(checkBillerForm({ ...good, senders: "ok.example\nnot an address" }).errors.senders).toMatch(
      /^"not an address" is not an email address or domain\./,
    );
    expect(checkBillerForm({ ...good, senders: "bad one\nbad two" }).errors.senders).toMatch(/One more has the same problem\.$/);
    expect(checkBillerForm({ ...good, senders: "bad one\nbad two\nbad three" }).errors.senders).toMatch(/2 more have the same problem\.$/);
  });

  it("limits how many senders and how long the notes", () => {
    const many = Array.from({ length: 51 }, (_, i) => `a${i}.example`).join("\n");
    expect(checkBillerForm({ ...good, senders: many }).errors.senders).toMatch(/at most 50/);
    expect(checkBillerForm({ ...good, notes: "x".repeat(2001) }).errors.notes).toMatch(/under 2000/);
  });
});

describe("newBillerPathFrom", () => {
  it("fills in the sender's name and address", () => {
    const path = newBillerPathFrom([{ name: "City Water", address: "billing@citywater.example" }]);
    const params = new URLSearchParams(path!.split("?")[1]);
    expect(path!.startsWith("/billers/new?")).toBe(true);
    expect(params.get("name")).toBe("City Water");
    expect(params.get("sender")).toBe("billing@citywater.example");
  });

  it("uses the domain when the email gives no name", () => {
    const path = newBillerPathFrom([{ name: "", address: "billing@citywater.example" }]);
    expect(new URLSearchParams(path!.split("?")[1]).get("name")).toBe("citywater.example");
  });

  it("keeps odd characters as text", () => {
    const path = newBillerPathFrom([{ name: "A&B <Power>?", address: "x@ab.example" }]);
    expect(new URLSearchParams(path!.split("?")[1]).get("name")).toBe("A&B <Power>?");
  });

  it("gives nothing when there is no address", () => {
    expect(newBillerPathFrom([])).toBeNull();
    expect(newBillerPathFrom([{ name: "Someone", address: "" }])).toBeNull();
  });
});

describe("addSenderPathFrom", () => {
  it("opens the biller with the sender to add", () => {
    const path = addSenderPathFrom(7, [{ name: "City Water", address: " billing@citywater.example " }]);
    expect(path).toBe("/billers/7?addSender=billing%40citywater.example");
  });

  it("gives nothing when there is no address", () => {
    expect(addSenderPathFrom(7, [])).toBeNull();
  });
});

describe("sendersWith", () => {
  it("adds the sender at the end, cleaned up", () => {
    expect(sendersWith(["a.example"], " Billing@B.example ")).toEqual({ text: "a.example\nbilling@b.example", added: "billing@b.example" });
  });

  it("adds nothing when it is already listed or missing", () => {
    expect(sendersWith(["a.example"], "A.example")).toEqual({ text: "a.example", added: null });
    expect(sendersWith(["a.example"], null)).toEqual({ text: "a.example", added: null });
    expect(sendersWith([], "  ")).toEqual({ text: "", added: null });
  });
});

describe("sendersSummary", () => {
  it("names one or two and counts the rest", () => {
    expect(sendersSummary(["a.example"])).toBe("a.example");
    expect(sendersSummary(["a.example", "b.example"])).toBe("a.example and b.example");
    expect(sendersSummary(["a.example", "b.example", "c.example"])).toBe("a.example and 2 more");
  });
});
