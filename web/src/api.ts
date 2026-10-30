// Talks to the OurHomeInbox server. Every call goes through request(), which
// sends the session cookie, turns a failed reply into an ApiRequestError
// carrying the server's plain-language `error` text, and tells the app when
// the server says the person is no longer signed in (401).

import type {
  ApiError,
  Biller,
  BillerInput,
  BillerListResponse,
  CaptureDetailResponse,
  CaptureListResponse,
  LoginRequest,
  SessionResponse,
  SettingsResponse,
  SetupRequest,
} from "../../src/shared/api";

export class ApiRequestError extends Error {
  /** The HTTP status, or 0 when the server could not be reached. */
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
  }
}

let unauthorizedHandler: (() => void) | null = null;

/** Called whenever a signed-in request comes back 401, so the app can show sign-in again. */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

interface RequestOptions {
  body?: unknown;
  signal?: AbortSignal;
  /** False for the sign-in and setup calls, where a 401 just means a wrong password. */
  signedIn?: boolean;
}

const UNREACHABLE = "Could not reach OurHomeInbox. Check that it is running, then try again.";

function isApiError(value: unknown): value is ApiError {
  return typeof value === "object" && value !== null && typeof (value as ApiError).error === "string";
}

async function request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const init: RequestInit = { method, headers, credentials: "same-origin", signal: options.signal };
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiRequestError(UNREACHABLE, 0);
  }

  if (!response.ok) {
    let message = `Something went wrong (error ${response.status}). Please try again.`;
    try {
      const data: unknown = await response.json();
      if (isApiError(data) && data.error.trim()) message = data.error;
    } catch {
      // Not JSON: keep the general message.
    }
    if (response.status === 401 && options.signedIn !== false) unauthorizedHandler?.();
    throw new ApiRequestError(message, response.status);
  }

  if (response.status === 204) return undefined as T;
  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiRequestError("OurHomeInbox sent a reply this page could not read. Please try again.", response.status);
  }
}

/** "<slug>/<uidValidity>/<uid>" with each part made safe for a URL. */
function encodeCaptureId(id: string): string {
  return id.split("/").map(encodeURIComponent).join("/");
}

/** The page address for one captured email, from CaptureListItem.id. */
export function capturePagePath(id: string): string {
  return `/mail/${encodeCaptureId(id)}`;
}

export function captureApiPath(id: string): string {
  return `/api/captures/${encodeCaptureId(id)}`;
}

export function captureRawUrl(id: string): string {
  return `${captureApiPath(id)}/raw`;
}

/** `index` is 1-based, as the server expects. */
export function captureAttachmentUrl(id: string, index: number): string {
  return `${captureApiPath(id)}/attachments/${index}`;
}

export const api = {
  getSession: (signal?: AbortSignal) => request<SessionResponse>("GET", "/api/session", { signal, signedIn: false }),
  signIn: (body: LoginRequest) => request<SessionResponse>("POST", "/api/session", { body, signedIn: false }),
  signOut: () => request<void>("DELETE", "/api/session", { signedIn: false }),
  setup: (body: SetupRequest) => request<SessionResponse>("POST", "/api/setup", { body, signedIn: false }),
  listCaptures: (signal?: AbortSignal) => request<CaptureListResponse>("GET", "/api/captures", { signal }),
  getCapture: (id: string, signal?: AbortSignal) => request<CaptureDetailResponse>("GET", captureApiPath(id), { signal }),
  getSettings: (signal?: AbortSignal) => request<SettingsResponse>("GET", "/api/settings", { signal }),
  listBillers: (signal?: AbortSignal) => request<BillerListResponse>("GET", "/api/billers", { signal }),
  getBiller: (id: number, signal?: AbortSignal) => request<Biller>("GET", `/api/billers/${id}`, { signal }),
  createBiller: (body: BillerInput) => request<Biller>("POST", "/api/billers", { body }),
  updateBiller: (id: number, body: BillerInput) => request<Biller>("PUT", `/api/billers/${id}`, { body }),
  deleteBiller: (id: number) => request<void>("DELETE", `/api/billers/${id}`),
};
