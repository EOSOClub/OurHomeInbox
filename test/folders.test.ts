import { describe, expect, it } from "vitest";
import { folderPath } from "../src/shared/folders.js";

describe("folderPath for Proton Mail Bridge", () => {
  const proton = (typed: string) => folderPath("proton-bridge", typed);

  it.each([
    ["Finance/Bills", "Folders/Finance/Bills"],
    ["Bills", "Folders/Bills"],
    ["  Finance/Bills  ", "Folders/Finance/Bills"],
    ["/Finance/Bills/", "Folders/Finance/Bills"],
    // A folder of your own that shares a name with one of Proton's, one level down, is still yours.
    ["Archive/2026", "Folders/Archive/2026"],
  ])("adds Folders/ to a folder typed as Proton shows it: %j -> %j", (typed, path) => {
    expect(proton(typed)).toBe(path);
  });

  it.each([
    ["Folders/Personal/Finance/Bills", "Folders/Personal/Finance/Bills"],
    ["Labels/Bill", "Labels/Bill"],
    ["folders/bills", "Folders/bills"],
    ["LABELS/Bill", "Labels/Bill"],
  ])("keeps a path that already says Folders/ or Labels/, written the Bridge's way: %j -> %j", (typed, path) => {
    expect(proton(typed)).toBe(path);
  });

  it.each([
    ["INBOX", "INBOX"],
    ["inbox", "INBOX"],
    ["Archive", "Archive"],
    ["all mail", "All Mail"],
    ["Spam", "Spam"],
  ])("keeps Proton's own folders: %j -> %j", (typed, path) => {
    expect(proton(typed)).toBe(path);
  });

  it("gives nothing for nothing", () => {
    expect(proton("  ")).toBe("");
    expect(proton("/")).toBe("");
  });
});
