// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TextField } from "./ui";

afterEach(cleanup);

describe("TextField", () => {
  it("shows the hint while there is no error", () => {
    render(<TextField label="Password" hint="At least 10 characters." />);
    expect(screen.getByText("At least 10 characters.")).toBeTruthy();
    expect(screen.getByLabelText("Password").getAttribute("aria-invalid")).toBeNull();
  });

  it("shows the error instead of the hint, not both", () => {
    render(<TextField label="Password" hint="At least 10 characters." error="Use at least 10 characters." />);
    expect(screen.queryByText("At least 10 characters.")).toBeNull();
    const input = screen.getByLabelText("Password");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const describedBy = input.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(describedBy)?.textContent).toBe("Use at least 10 characters.");
  });
});
