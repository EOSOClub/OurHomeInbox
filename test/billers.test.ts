import { describe, expect, it } from "vitest";
import { isDomain, normalizeSender, parseSenders, senderProblem } from "../src/shared/billers.js";

describe("normalizeSender", () => {
  it("lowercases and trims", () => {
    expect(normalizeSender("  Billing@CityWater.Example ")).toBe("billing@citywater.example");
  });

  it("treats a leading @ as the domain", () => {
    expect(normalizeSender("@CityWater.example")).toBe("citywater.example");
  });

  it("keeps only the address from a pasted From line", () => {
    expect(normalizeSender('"City Water" <Billing@CityWater.example>')).toBe("billing@citywater.example");
    expect(normalizeSender("City Water <billing@citywater.example> ")).toBe("billing@citywater.example");
  });

  it("drops mailto: and a trailing dot", () => {
    expect(normalizeSender("mailto:billing@citywater.example")).toBe("billing@citywater.example");
    expect(normalizeSender("citywater.example.")).toBe("citywater.example");
  });
});

describe("parseSenders", () => {
  it("splits on lines, commas and semicolons, dropping blanks and repeats", () => {
    expect(parseSenders("billing@a.example\n\n b.example, @B.example;c.example\r\n")).toEqual([
      "billing@a.example",
      "b.example",
      "c.example",
    ]);
  });

  it("gives nothing for an empty box", () => {
    expect(parseSenders("  \n , ")).toEqual([]);
  });
});

describe("senderProblem", () => {
  it("accepts addresses and domains", () => {
    for (const ok of ["billing@citywater.example", "citywater.example", "mail.citywater.example", "first.last+bills@x.co", "élec.example", "a-b.c-d.example"]) {
      expect(senderProblem(ok), ok).toBeNull();
    }
  });

  it("refuses anything else, with an example of what works", () => {
    for (const bad of ["not an address", "billing@", "@", "localhost", "a@b@c.example", "-bad.example", "bad-.example", "a..b.example", "x@y,z.example"]) {
      expect(senderProblem(bad), bad).toMatch(/is not an email address or domain\. Use a full address like billing@citywater\.com/);
    }
  });

  it("refuses one longer than an address can be", () => {
    expect(senderProblem(`${"a".repeat(250)}.example`)).toMatch(/too long/);
  });
});

describe("isDomain", () => {
  it("tells a domain from an address", () => {
    expect(isDomain("citywater.example")).toBe(true);
    expect(isDomain("billing@citywater.example")).toBe(false);
  });
});
