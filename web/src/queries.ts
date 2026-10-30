// The data the pages read from the server, through TanStack Query, so each
// piece is fetched once, cached, and refreshed in the background.

import { QueryClient, useQuery } from "@tanstack/react-query";
import type { SessionResponse } from "../../src/shared/api";
import { api, ApiRequestError } from "./api";

export const queryKeys = {
  session: ["session"] as const,
  captures: ["captures"] as const,
  capture: (id: string) => ["captures", id] as const,
  settings: ["settings"] as const,
  billers: ["billers"] as const,
  biller: (id: number) => ["billers", id] as const,
};

export const SIGNED_OUT: SessionResponse = { user: null, setupNeeded: false };

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        // A 4xx answer (not found, signed out) will not change on a retry.
        retry: (failureCount, error) =>
          !(error instanceof ApiRequestError && error.status >= 400 && error.status < 500) && failureCount < 2,
      },
    },
  });
}

/** Forgets everything fetched while signed in, and shows sign-in. */
export function showSignedOut(client: QueryClient): void {
  client.removeQueries({ predicate: (query) => query.queryKey[0] !== queryKeys.session[0] });
  client.setQueryData(queryKeys.session, SIGNED_OUT);
}

export function useSession() {
  return useQuery({ queryKey: queryKeys.session, queryFn: ({ signal }) => api.getSession(signal) });
}

export function useCaptures() {
  return useQuery({ queryKey: queryKeys.captures, queryFn: ({ signal }) => api.listCaptures(signal) });
}

export function useCapture(id: string) {
  return useQuery({ queryKey: queryKeys.capture(id), queryFn: ({ signal }) => api.getCapture(id, signal) });
}

export function useSettings(enabled = true) {
  return useQuery({ queryKey: queryKeys.settings, queryFn: ({ signal }) => api.getSettings(signal), enabled });
}

export function useBillers() {
  return useQuery({ queryKey: queryKeys.billers, queryFn: ({ signal }) => api.listBillers(signal) });
}

export function useBiller(id: number) {
  return useQuery({ queryKey: queryKeys.biller(id), queryFn: ({ signal }) => api.getBiller(id, signal) });
}
