import { afterEach, describe, expect, it } from "vitest";
import { call, makeServer, setUp, type TestServer } from "./helpers.js";

let server: TestServer;

afterEach(() => {
  server.close();
});

const HTML_CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-src 'self'; " +
  "frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";

describe("the web app", () => {
  it("serves index.html at / with the page's security policy", async () => {
    server = makeServer({ webRoot: true });
    const res = await call(server.app, "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/^text\/html/);
    expect(await res.text()).toContain("<div id=root>");
    expect(res.headers.get("Content-Security-Policy")).toBe(HTML_CSP);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  it("falls back to index.html for the app's own pages", async () => {
    server = makeServer({ webRoot: true });
    const res = await call(server.app, "/captures/proton-bills/1700000000/7");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<div id=root>");
    expect(res.headers.get("Content-Security-Policy")).toBe(HTML_CSP);
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
  });

  it("serves built files, and 404s a missing one instead of the page", async () => {
    server = makeServer({ webRoot: true });
    const res = await call(server.app, "/assets/app-abc123.js");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("console.log('app');");
    expect(res.headers.get("Cache-Control")).toContain("immutable");
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
    expect((await call(server.app, "/assets/missing.js")).status).toBe(404);
  });

  it("never serves files outside the web folder", async () => {
    server = makeServer({ webRoot: true });
    for (const path of ["/..%2Fdata%2Fourhomeinbox.db", "/%2e%2e/data/ourhomeinbox.db", "/assets/..%5C..%5Cdata%5Courhomeinbox.db"]) {
      const res = await call(server.app, path);
      expect(await res.text(), path).not.toContain("SQLite");
    }
  });

  it("serves no page when there is no web app", async () => {
    server = makeServer();
    const res = await call(server.app, "/");
    expect(res.status).toBe(404);
  });
});

describe("the API's edges", () => {
  it("answers an unknown API address with a JSON 404, not the app's page", async () => {
    server = makeServer({ webRoot: true });
    const cookie = await setUp(server.app);
    for (const path of ["/api/nope", "/api", "/api/captures/proton-bills"]) {
      const res = await call(server.app, path, { cookie });
      expect(res.status, path).toBe(404);
      expect(res.headers.get("Content-Type"), path).toMatch(/^application\/json/);
      expect(await res.json()).toEqual({ error: "There is nothing here." });
    }
    const wrongMethod = await call(server.app, "/api/settings", { method: "POST", cookie, body: {} });
    expect(wrongMethod.status).toBe(404);
  });

  it("marks every API reply as not to be cached or shown as a page", async () => {
    server = makeServer();
    for (const path of ["/api/health", "/api/session", "/api/captures"]) {
      const res = await call(server.app, path);
      expect(res.headers.get("Cache-Control"), path).toBe("no-store");
      expect(res.headers.get("X-Content-Type-Options"), path).toBe("nosniff");
      expect(res.headers.get("Referrer-Policy"), path).toBe("no-referrer");
      expect(res.headers.get("Content-Security-Policy"), path).toContain("default-src 'none'");
    }
  });
});
