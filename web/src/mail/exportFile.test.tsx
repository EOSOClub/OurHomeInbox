// @vitest-environment jsdom
// Export: saving the file in each format, and the list page's "Export as"
// choice with its Export buttons (what is shown, or what is selected).

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { strFromU8, unzipSync } from "fflate";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CaptureListPage } from "../pages/CaptureListPage";
import { capturesCsv } from "./exportCsv";
import { downloadExport, exportFileName } from "./exportFile";
import { blobBytes, blobText, exportItem as item } from "./exportFixtures";
import type { ExportedFile } from "./exportJson";

// jsdom has no blob links; each test puts in its own, and they come out after.
const realBlobUrls = { createObjectURL: URL.createObjectURL, revokeObjectURL: URL.revokeObjectURL };

/** Blob links for the test: `create` is handed each file saved. */
function stubBlobUrls(create: (blob: Blob) => string) {
  Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Object.assign(URL, realBlobUrls);
});

describe("downloadExport", () => {
  let blobs: Blob[];
  let clicked: Array<{ name: string; href: string }>;
  const now = new Date(2026, 10, 1, 9, 30);

  beforeEach(() => {
    blobs = [];
    clicked = [];
    stubBlobUrls((b) => (blobs.push(b), "blob:test"));
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ name: this.download, href: this.getAttribute("href") ?? "" });
    });
  });

  it("names each file after today and its format", () => {
    expect(exportFileName("csv", now)).toBe("ourhome-inbox-2026-11-01.csv");
    expect(exportFileName("xlsx", now)).toBe("ourhome-inbox-2026-11-01.xlsx");
    expect(exportFileName("json", now)).toBe("ourhome-inbox-2026-11-01.json");
  });

  it("saves the CSV with a byte order mark", async () => {
    expect(downloadExport([item("1")], "csv", now)).toBe("ourhome-inbox-2026-11-01.csv");
    expect(clicked).toEqual([{ name: "ourhome-inbox-2026-11-01.csv", href: "blob:test" }]);
    expect(blobs[0]!.type).toBe("text/csv;charset=utf-8");
    const text = await blobText(blobs[0]!);
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text.slice(1)).toBe(capturesCsv([item("1")]));
    // The link is gone from the page afterwards.
    expect(document.querySelector("a[download]")).toBeNull();
  });

  it("saves an Excel workbook", async () => {
    expect(downloadExport([item("1")], "xlsx", now)).toBe("ourhome-inbox-2026-11-01.xlsx");
    expect(blobs[0]!.type).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    const files = unzipSync(await blobBytes(blobs[0]!));
    expect(strFromU8(files["xl/worksheets/sheet1.xml"]!)).toContain("Bill 1");
  });

  it("saves JSON", async () => {
    expect(downloadExport([item("1")], "json", now)).toBe("ourhome-inbox-2026-11-01.json");
    expect(blobs[0]!.type).toBe("application/json");
    const file = JSON.parse(await blobText(blobs[0]!)) as ExportedFile;
    expect(file).toMatchObject({ exportedAt: now.toISOString(), count: 1, emails: [{ id: "proton-bills/1/1" }] });
  });
});

describe("Export on the list page", () => {
  const EMAILS = [
    item("3", { subject: "Final notice", picked: { ...item("3").picked, dueNow: true } }),
    item("2", { subject: "Payment reminder" }),
    item("1", { subject: "Water bill" }),
  ];
  let saved: Blob[];

  beforeEach(() => {
    saved = [];
    stubBlobUrls((b) => (saved.push(b), "blob:test"));
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        const body = path === "/api/captures" ? { captures: EMAILS } : path === "/api/tags" ? { tags: [] } : null;
        return new Response(JSON.stringify(body ?? { error: "There is nothing here." }), {
          status: body ? 200 : 404,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
  });

  function show(path = "/") {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/" element={<CaptureListPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  /** The subjects in a saved CSV, top to bottom. */
  const csvSubjects = async (index = 0) =>
    (await blobText(saved[index]!))
      .slice(1)
      .split("\r\n")
      .filter(Boolean)
      .slice(1)
      .map((line) => line.split(",")[3]);
  const formatChoice = () => screen.getByRole("combobox", { name: "Export as" }) as HTMLSelectElement;

  it("offers CSV, Excel and JSON, with CSV chosen", async () => {
    show();
    await screen.findByRole("button", { name: "Export 3 emails" });
    expect(formatChoice().value).toBe("csv");
    expect(Array.from(formatChoice().options).map((o) => o.textContent)).toEqual(["CSV", "Excel (.xlsx)", "JSON"]);
  });

  it("exports every email, or only the ones the filters leave", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Export 3 emails" }));
    expect(await csvSubjects()).toEqual(["Final notice", "Payment reminder", "Water bill"]);
    expect(screen.getByText(`Saved 3 emails to ${exportFileName("csv")}.`)).toBeTruthy();

    // Narrowing the list takes the message away: it described the old list.
    fireEvent.change(screen.getByRole("searchbox", { name: "Search captured mail" }), { target: { value: "reminder" } });
    expect(screen.queryByText(`Saved 3 emails to ${exportFileName("csv")}.`)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Export 1 email" }));
    expect(await csvSubjects(1)).toEqual(["Payment reminder"]);
    expect(screen.getByText(`Saved 1 email to ${exportFileName("csv")}.`)).toBeTruthy();
  });

  it("saves in the format chosen", async () => {
    show();
    await screen.findByRole("button", { name: "Export 3 emails" });
    fireEvent.change(formatChoice(), { target: { value: "xlsx" } });
    fireEvent.click(screen.getByRole("button", { name: "Export 3 emails" }));
    expect(saved[0]!.type).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(screen.getByText(`Saved 3 emails to ${exportFileName("xlsx")}.`)).toBeTruthy();

    fireEvent.change(formatChoice(), { target: { value: "json" } });
    fireEvent.click(screen.getByRole("button", { name: "Export 3 emails" }));
    const file = JSON.parse(await blobText(saved[1]!)) as ExportedFile;
    expect(file.emails.map((e) => e.subject)).toEqual(["Final notice", "Payment reminder", "Water bill"]);
    expect(screen.getByText(`Saved 3 emails to ${exportFileName("json")}.`)).toBeTruthy();
  });

  it("offers no Export when nothing is shown", async () => {
    show("/?q=nothing-matches");
    await screen.findByText(/No captured mail matches/);
    expect(screen.queryByRole("button", { name: /^Export/ })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Export as" })).toBeNull();
  });

  it("exports the selected emails from the Select bar, in the same format", async () => {
    show();
    await screen.findByRole("button", { name: "Export 3 emails" });
    fireEvent.change(formatChoice(), { target: { value: "json" } });
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    // The bar's Export takes over while selecting, and shows once something is ticked.
    expect(screen.queryByRole("button", { name: "Export 3 emails" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Export selected" })).toBeNull();

    fireEvent.click(screen.getByRole("checkbox", { name: /Select: Water bill/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Select: Final notice/ }));
    // The choice carried over from the list.
    expect(formatChoice().value).toBe("json");
    fireEvent.click(screen.getByRole("button", { name: "Export selected" }));
    // In the list's order, not the order they were ticked.
    const file = JSON.parse(await blobText(saved[0]!)) as ExportedFile;
    expect(file.emails.map((e) => e.subject)).toEqual(["Final notice", "Water bill"]);
    await waitFor(() => expect(screen.getByText(`Saved 2 emails to ${exportFileName("json")}.`)).toBeTruthy());
  });

  it("says so when the browser cannot save the file", async () => {
    stubBlobUrls(() => {
      throw new Error("Saving files is turned off.");
    });
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Export 3 emails" }));
    expect(screen.getByRole("alert").textContent).toContain("Could not export: Saving files is turned off.");
  });
});
