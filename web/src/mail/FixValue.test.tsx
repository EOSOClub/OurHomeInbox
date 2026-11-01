// @vitest-environment jsdom
// Fix on an email (choosing a value saves a rule on its biller) and the rules
// list on the biller's page, against a stand-in server: fetch answers with
// what the real server's reader gives for the same email.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { choicesFor, extract, PreparedEmail } from "../../../src/server/extraction";
import { checkSender } from "../../../src/server/sender";
import type { Biller, BillerMatch, BillerRulesResponse, CaptureDetailResponse, FieldChoicesResponse } from "../../../src/shared/api";
import type { Capture } from "../../../src/shared/capture";
import type { BillerRule, FieldName } from "../../../src/shared/extraction";
import { EditBillerPage } from "../pages/BillerEditPage";
import { CaptureDetailView } from "./CaptureDetailView";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const BILLER: BillerMatch = { id: 3, name: "Xcel Energy", kind: "bill", matchedOn: "xcelenergy.com" };
const ID = "proton-bills/123/45";

function makeCapture(html: string): Capture {
  return {
    version: 1,
    mailbox: "Proton bills",
    folder: "Folders/Bills",
    uidValidity: "123",
    uid: 45,
    capturedAt: "2026-10-29T15:00:00Z",
    raw: { file: "message.eml", size: 2048, sha256: "a".repeat(64) },
    messageId: "<abc@xcelenergy.com>",
    subject: "Your Statement is Ready",
    date: "2026-10-28T09:30:00Z",
    from: [{ name: "Xcel Energy", address: "noreply@xcelenergy.com" }],
    to: [],
    cc: [],
    replyTo: [],
    headers: [],
    text: null,
    html,
    attachments: [],
    links: [],
  };
}

const XCEL = makeCapture(
  "<table><tr><td>Due Date: 11/12/2026</td></tr><tr><td>Payment Amount:</td><td>$194.26</td></tr><tr><td>Current Charges*: $202.63</td></tr></table>",
);

function reply(status: number, body?: unknown): Response {
  return body === undefined ? new Response(null, { status }) : new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** A stand-in server for one email from BILLER, whose rules are `rules`; it records what was sent. */
function stubServer(capture: Capture, rules: BillerRule[] = []) {
  const sent: Array<[string, string, unknown]> = [];
  const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    sent.push([method, path, init?.body ? JSON.parse(String(init.body)) : undefined]);
    const choices = /\/choices\/(\w+)$/.exec(path);
    if (method === "GET" && choices) {
      const field = choices[1] as FieldName;
      const body: FieldChoicesResponse = {
        field,
        biller: BILLER,
        rule: rules.find((r) => r.field === field) ?? null,
        otherEmails: 0,
        choices: choicesFor(new PreparedEmail(capture), field, rules, []),
      };
      return reply(200, body);
    }
    if (method === "PUT" || method === "DELETE") return reply(204);
    return reply(404, { error: "There is nothing here." });
  });
  vi.stubGlobal("fetch", fetchMock);
  return sent;
}

function withQueries(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function showEmail(capture: Capture, biller: BillerMatch | null = BILLER, rules: BillerRule[] = []) {
  const detail: CaptureDetailResponse = {
    id: ID,
    mailboxSlug: "proton-bills",
    capture,
    biller,
    sender: checkSender(capture),
    invoice: null,
    extraction: extract(capture, rules),
    tags: [],
    review: null,
  };
  render(withQueries(<CaptureDetailView detail={detail} />));
  return screen.getByRole("region", { name: "Picked out" });
}

describe("Fix on an email", () => {
  it("lists the amounts in the email and saves the one chosen as a rule on the biller", async () => {
    const sent = stubServer(XCEL);
    const picked = showEmail(XCEL);
    expect(picked.textContent).toContain("If a value is wrong or missing, use Fix: your choice is used for every email from Xcel Energy.");

    fireEvent.click(within(picked).getByRole("button", { name: "Fix the amount" }));
    const fix = within(picked).getByRole("group", { name: "Which is the amount?" });
    expect(document.activeElement?.textContent).toBe("Which is the amount?");
    const options = await within(fix).findAllByRole("radio");
    expect(options.map((o) => o.closest("label")?.textContent)).toEqual([
      expect.stringMatching(/^\$194\.26Picked nowAfter "Payment Amount"/),
      expect.stringMatching(/^\$202\.63After "Current Charges"/),
    ]);
    const use = within(fix).getByRole("button", { name: "Use this one" });
    expect(use).toHaveProperty("disabled", true);

    fireEvent.click(options[1]!);
    expect(fix.textContent).toContain("There are no other emails from Xcel Energy yet. New ones will use it too.");
    expect(use).toHaveProperty("disabled", false);
    fireEvent.click(use);

    expect(await within(picked).findByText(/^Saved\./)).toHaveProperty(
      "textContent",
      'Saved. The amount in every email from Xcel Energy is now the value after "Current Charges".',
    );
    expect(within(picked).queryByRole("group")).toBeNull();
    expect(sent.filter(([method]) => method === "PUT")).toEqual([["PUT", "/api/billers/3/rules/amount", { label: "Current Charges" }]]);
  });

  it("shows a value found by a rule, and removes the rule", async () => {
    const rules: BillerRule[] = [{ field: "amount", label: "Current Charges" }];
    const sent = stubServer(XCEL, rules);
    const picked = showEmail(XCEL, BILLER, rules);
    expect(picked.textContent).toContain('Found after "Current Charges", by your rule');
    expect(picked.textContent).toContain("and by your rules for Xcel Energy.");

    fireEvent.click(within(picked).getByRole("button", { name: "Fix the amount" }));
    const fix = within(picked).getByRole("group", { name: "Which is the amount?" });
    expect(await within(fix).findByText('Picked now by your rule: the value after "Current Charges".')).toBeTruthy();
    fireEvent.click(within(fix).getByRole("button", { name: "Remove the rule" }));
    expect(await within(picked).findByText(/^Rule removed\./)).toBeTruthy();
    expect(sent.filter(([method]) => method === "DELETE")).toEqual([["DELETE", "/api/billers/3/rules/amount", undefined]]);
  });

  it("picks out a value that is not shown, and says when the email has nothing to choose", async () => {
    stubServer(XCEL);
    const picked = showEmail(XCEL);
    const select = within(picked).getByRole("combobox", { name: "Pick out something else:" });
    expect([...select.querySelectorAll("option")].map((o) => o.textContent)).toEqual([
      "Choose a value...",
      "Fee",
      "Paid on",
      "Account number",
      "Invoice number",
      "Confirmation number",
    ]);
    fireEvent.change(select, { target: { value: "confirmationNo" } });
    const fix = within(picked).getByRole("group", { name: "Which is the confirmation number?" });
    expect(picked.textContent).toContain("Not picked out yet");
    expect(await within(fix).findByText(/Nothing in this email looks like a number with words before it/)).toBeTruthy();
    fireEvent.click(within(fix).getByRole("button", { name: "Cancel" }));
    expect(picked.textContent).not.toContain("Not picked out yet");
  });

  it("is not offered until the sender belongs to a biller", () => {
    stubServer(XCEL);
    const picked = showEmail(XCEL, null);
    expect(within(picked).queryByRole("button", { name: /^Fix/ })).toBeNull();
    expect(within(picked).queryByRole("combobox")).toBeNull();
    expect(picked.textContent).toContain("To fix a value, first add this email's sender to a biller.");
  });
});

describe("the rules on a biller's page", () => {
  const biller: Biller = {
    id: 3,
    name: "Xcel Energy",
    kind: "bill",
    senders: ["xcelenergy.com"],
    notes: "",
    fetchInvoices: true,
    createdAt: "2026-10-29T00:00:00.000Z",
    updatedAt: "2026-10-29T00:00:00.000Z",
  };

  function showBillerPage(rules: BillerRulesResponse) {
    const sent: Array<[string, string]> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        sent.push([method, path]);
        if (path === "/api/billers/3") return reply(200, biller);
        if (path === "/api/billers/3/rules" && method === "GET") return reply(200, rules);
        if (method === "DELETE") return reply(204);
        return reply(404, { error: "There is nothing here." });
      }),
    );
    render(
      withQueries(
        <MemoryRouter initialEntries={["/billers/3"]}>
          <Routes>
            <Route path="/billers/:id" element={<EditBillerPage />} />
          </Routes>
        </MemoryRouter>,
      ),
    );
    return sent;
  }

  it("lists each rule with how often it is used, and removes one", async () => {
    const sent = showBillerPage({
      rules: [{ field: "amount", label: "Current Charges", createdAt: "2026-10-30T08:00:00.000Z", usedOn: 2 }],
      emails: 3,
    });
    const card = (await screen.findByRole("heading", { name: "Where values are found" })).closest("section")!;
    await waitFor(() => expect(card.textContent).toContain('AmountThe value after "Current Charges"Used in 2 of 3 emails'));
    fireEvent.click(within(card).getByRole("button", { name: "Remove the rule for the amount" }));
    await waitFor(() => expect(sent).toContainEqual(["DELETE", "/api/billers/3/rules/amount"]));
  });

  it("says how to add one when there are none", async () => {
    showBillerPage({ rules: [], emails: 3 });
    expect(await screen.findByText(/^No rules yet\./)).toBeTruthy();
  });
});
