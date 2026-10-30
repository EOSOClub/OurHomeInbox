// Tests for the API client: cookies sent, server error text passed on, 401
// handling, and safe capture addresses.

import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiRequestError, captureAttachmentUrl, capturePagePath, captureRawUrl, setUnauthorizedHandler } from "./api";

function reply(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  setUnauthorizedHandler(null);
});

describe("api", () => {
  it("sends the session cookie and JSON", async () => {
    const fetchMock = vi.fn(async () => reply(200, { user: null, setupNeeded: false }));
    vi.stubGlobal("fetch", fetchMock);
    await api.signIn({ email: "a@b.example", password: "secret-secret" });
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/session");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ email: "a@b.example", password: "secret-secret" }));
  });

  it("throws the server's own error text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(404, { error: "That email was not found." })));
    await expect(api.getCapture("box/1/2")).rejects.toMatchObject({ message: "That email was not found.", status: 404 });
  });

  it("gives a general message when the reply has no error text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("oops", { status: 500 })));
    await expect(api.listCaptures()).rejects.toThrow("Something went wrong (error 500). Please try again.");
  });

  it("says when the server cannot be reached", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    const error = await api.getSettings().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect((error as ApiRequestError).status).toBe(0);
  });

  it("sends the person back to sign-in on a 401 from a signed-in call", async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    vi.stubGlobal("fetch", vi.fn(async () => reply(401, { error: "Please sign in." })));
    await expect(api.listCaptures()).rejects.toThrow("Please sign in.");
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("does not treat a wrong password as being signed out", async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    vi.stubGlobal("fetch", vi.fn(async () => reply(401, { error: "Wrong email or password." })));
    await expect(api.signIn({ email: "a@b.example", password: "x" })).rejects.toThrow("Wrong email or password.");
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("accepts an empty 204 reply", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    await expect(api.signOut()).resolves.toBeUndefined();
  });
});

describe("capture addresses", () => {
  it("builds page and download paths from the list id", () => {
    expect(capturePagePath("proton-bills/123/45")).toBe("/mail/proton-bills/123/45");
    expect(captureRawUrl("proton-bills/123/45")).toBe("/api/captures/proton-bills/123/45/raw");
    expect(captureAttachmentUrl("proton-bills/123/45", 2)).toBe("/api/captures/proton-bills/123/45/attachments/2");
  });

  it("encodes each part so odd characters cannot change the path", () => {
    expect(capturePagePath("a b/1?x/2#y")).toBe("/mail/a%20b/1%3Fx/2%23y");
  });
});
