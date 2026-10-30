// Shared pieces of the HTTP layer: the request context's types, plain-language
// error replies, body validation, and the protections every request passes
// through (security headers, the cross-site check, the body size limit).

import { getConnInfo } from "@hono/node-server/conninfo";
import { zValidator } from "@hono/zod-validator";
import type { Context, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";
import type { ApiError, SessionUser } from "../shared/api.js";

export interface AppEnv {
  Variables: {
    /** The signed-in user, or null. Set for every /api request. */
    user: SessionUser | null;
    /** The session cookie's token when it names a live session. */
    sessionToken: string | null;
  };
}

export function apiError(c: Context, status: ContentfulStatusCode, message: string): Response {
  const body: ApiError = { error: message };
  return c.json(body, status);
}

export const MESSAGES = {
  badJson: "The request could not be read. Please try again.",
  badShape: "Some of what was sent is missing or not in the right form.",
  tooLarge: "That request is too large.",
  notJson: "The request was sent in a form OurHomeInbox does not accept.",
  crossSite: "This request came from another website, so it was blocked.",
  signIn: "Please sign in first.",
  notFound: "There is nothing here.",
  server: "Something went wrong on the server. Please try again in a moment.",
} as const;

/** The signed-in person's household. Only for routes behind requireSignIn, which guarantees a user. */
export function householdOf(c: Context<AppEnv>): number {
  return (c.var.user as SessionUser).household.id;
}

/** Validates a JSON body with `schema`; a failure is a 400 with the first problem's message. */
export function jsonBody<T extends z.ZodType>(schema: T) {
  return zValidator("json", schema, (result, c) => {
    if (!result.success) return apiError(c, 400, result.error.issues[0]?.message ?? MESSAGES.badShape);
  });
}

/** True when the browser reached us over https, directly or through a proxy that says so. */
export function isHttps(c: Context): boolean {
  if (new URL(c.req.url).protocol === "https:") return true;
  return c.req.header("X-Forwarded-Proto")?.split(",")[0]?.trim().toLowerCase() === "https";
}

/** This server's origin as the browser sees it, e.g. "https://inbox.home.example". */
export function ownOrigin(c: Context): string {
  const url = new URL(c.req.url);
  return `${isHttps(c) ? "https:" : url.protocol}//${url.host}`;
}

/**
 * The client's network address, for the failed sign-in limit. This is the
 * direct connection's address; behind a reverse proxy every client shares the
 * proxy's, which makes the per-address limit stricter, never looser.
 * X-Forwarded-For is not trusted because any client can send it.
 */
export function clientIp(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown"; // no Node connection, e.g. app.request() in tests
  }
}

const HTML_CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-src 'self'; " +
  "frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";
// API replies are data, never pages: nothing in one may load or run.
const API_CSP = "default-src 'none'; frame-ancestors 'none'; sandbox";

/** Headers on every response; set after the route so they cover errors and 404s too. */
export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  const headers = c.res.headers;
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  if (c.req.path === "/api" || c.req.path.startsWith("/api/")) {
    headers.set("Cache-Control", "no-store");
    headers.set("Content-Security-Policy", API_CSP);
  } else if (headers.get("Content-Type")?.toLowerCase().startsWith("text/html")) {
    headers.set("Content-Security-Policy", HTML_CSP);
  }
};

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const JSON_TYPE = /^application\/json\s*(;|$)/i;

/**
 * Blocks requests another website makes the browser send (cross-site request
 * forgery). A browser always says where a cross-site request comes from, in
 * Origin and in Sec-Fetch-Site, and cannot send a cross-site JSON body without
 * asking first (which this server never allows). Apps that are not browsers
 * send neither header and pass.
 */
export const crossSiteCheck: MiddlewareHandler = async (c, next) => {
  if (!UNSAFE_METHODS.has(c.req.method)) return next();

  const origin = c.req.header("Origin");
  if (origin !== undefined && origin !== ownOrigin(c)) return apiError(c, 403, MESSAGES.crossSite);
  const fetchSite = c.req.header("Sec-Fetch-Site");
  if (fetchSite !== undefined && fetchSite !== "same-origin" && fetchSite !== "none") {
    return apiError(c, 403, MESSAGES.crossSite);
  }

  // Read here so a body is never left unchecked; later reads use Hono's cached copy.
  const body = await c.req.text();
  if (body !== "" && !JSON_TYPE.test(c.req.header("Content-Type") ?? "")) return apiError(c, 415, MESSAGES.notJson);
  return next();
};

/** Request bodies are small JSON objects; anything bigger is refused before it is read. */
export const MAX_BODY_BYTES = 64 * 1024;
