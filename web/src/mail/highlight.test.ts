// Tests for splitting body text into plain and highlighted pieces.

import { describe, expect, it } from "vitest";
import { segmentText } from "./highlight";

describe("segmentText", () => {
  it("returns the whole text when nothing is highlighted", () => {
    expect(segmentText("Amount due: $42.10")).toEqual([{ text: "Amount due: $42.10", highlight: null }]);
    expect(segmentText("")).toEqual([{ text: "", highlight: null }]);
  });

  it("splits around highlights in order, whatever order they come in", () => {
    const text = "Due 2026-11-05, amount $42.10";
    const segments = segmentText(text, [
      { start: 23, end: 29, label: "Amount" },
      { start: 4, end: 14, label: "Due date" },
    ]);
    expect(segments.map((s) => s.text)).toEqual(["Due ", "2026-11-05", ", amount ", "$42.10"]);
    expect(segments.map((s) => s.highlight?.label ?? null)).toEqual([null, "Due date", null, "Amount"]);
    expect(segments.map((s) => s.text).join("")).toBe(text);
  });

  it("clamps ranges and skips empty or overlapping ones", () => {
    const segments = segmentText("abcdef", [
      { start: 1, end: 3 },
      { start: 2, end: 4 },
      { start: 5, end: 5 },
      { start: 4, end: 99 },
    ]);
    expect(segments.map((s) => [s.text, s.highlight !== null])).toEqual([
      ["a", false],
      ["bc", true],
      ["d", false],
      ["ef", true],
    ]);
  });
});
