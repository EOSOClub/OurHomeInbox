// Tests for the first-time setup form's checks.

import { describe, expect, it } from "vitest";
import { MIN_PASSWORD_LENGTH } from "../../../src/shared/api";
import { validateSetup } from "./SetupPage";

const good = {
  householdName: "The Smiths",
  name: "Sam",
  email: "sam@example.com",
  password: "x".repeat(MIN_PASSWORD_LENGTH),
  confirm: "x".repeat(MIN_PASSWORD_LENGTH),
};

describe("validateSetup", () => {
  it("accepts a complete form", () => {
    expect(validateSetup(good)).toEqual({});
  });

  it("asks for every field", () => {
    const errors = validateSetup({ householdName: " ", name: "", email: "", password: "", confirm: "" });
    expect(Object.keys(errors).sort()).toEqual(["email", "householdName", "name", "password"]);
  });

  it("needs a long enough password, typed twice", () => {
    const short = "x".repeat(MIN_PASSWORD_LENGTH - 1);
    expect(validateSetup({ ...good, password: short, confirm: short }).password).toBe(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
    expect(validateSetup({ ...good, confirm: "different-password" }).confirm).toBe("The two passwords do not match.");
  });
});
