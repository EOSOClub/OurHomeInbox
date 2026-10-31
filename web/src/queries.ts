// The data the pages read from the server, through TanStack Query, so each
// piece is fetched once, cached, and refreshed in the background.

import { QueryClient, useQuery } from "@tanstack/react-query";
import type { SessionResponse } from "../../src/shared/api";
import type { FieldName } from "../../src/shared/extraction";
import { api, ApiRequestError } from "./api";

export const queryKeys = {
  session: ["session"] as const,
  captures: ["captures"] as const,
  capture: (id: string) => ["captures", id] as const,
  // Under the email, so whatever refreshes the email refreshes these too.
  choices: (id: string, field: FieldName) => ["captures", id, "choices", field] as const,
  settings: ["settings"] as const,
  mailboxes: ["mailboxes"] as const,
  status: ["status"] as const,
  billers: ["billers"] as const,
  biller: (id: number) => ["billers", id] as const,
  billerRules: (id: number) => ["billers", id, "rules"] as const,
};

/** Every biller's rules list, whichever biller. */
const isRulesQuery = (query: { queryKey: readonly unknown[] }) => query.queryKey[0] === queryKeys.billers[0] && query.queryKey[2] === "rules";

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

/**
 * After a biller is added, changed or deleted: the biller list, every
 * email's matched biller, and the rules lists (which count the emails a
 * biller's senders cover).
 */
export function refreshAfterBillerChange(client: QueryClient): void {
  void client.invalidateQueries({ queryKey: queryKeys.billers, exact: true });
  void client.invalidateQueries({ queryKey: queryKeys.captures });
  void client.invalidateQueries({ predicate: isRulesQuery });
}

/** After a rule is saved or removed: every email (what was picked out of it) and the biller's rules list. */
export function refreshAfterRuleChange(client: QueryClient, billerId: number): void {
  void client.invalidateQueries({ queryKey: queryKeys.captures });
  void client.invalidateQueries({ queryKey: queryKeys.billerRules(billerId) });
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

/**
 * The household's mailboxes and when mail is read. While a read is running it
 * is asked again every few seconds, so the page shows when it finishes.
 */
export function useMailboxes() {
  return useQuery({
    queryKey: queryKeys.mailboxes,
    queryFn: ({ signal }) => api.listMailboxes(signal),
    refetchInterval: (query) => (query.state.data?.checking.running ? 2000 : false),
  });
}

/** After a mailbox is added, changed or removed, or mail was read: the mailboxes, the status, and every email (which mailboxes are shown). */
export function refreshAfterMailboxChange(client: QueryClient): void {
  void client.invalidateQueries({ queryKey: queryKeys.mailboxes });
  void client.invalidateQueries({ queryKey: queryKeys.status });
  void client.invalidateQueries({ queryKey: queryKeys.captures });
}

/** Whether OurHomeInbox is working. Asked again every few seconds while mail is being read, else every minute. */
export function useStatus() {
  return useQuery({
    queryKey: queryKeys.status,
    queryFn: ({ signal }) => api.getStatus(signal),
    refetchInterval: (query) => (query.state.data?.checking.running ? 2000 : 60_000),
  });
}

export function useBillers() {
  return useQuery({ queryKey: queryKeys.billers, queryFn: ({ signal }) => api.listBillers(signal) });
}

export function useBiller(id: number) {
  return useQuery({ queryKey: queryKeys.biller(id), queryFn: ({ signal }) => api.getBiller(id, signal) });
}

/** What Fix offers for one value of an email. Always fetched fresh when Fix opens, as other emails may have changed. */
export function useChoices(id: string, field: FieldName) {
  return useQuery({ queryKey: queryKeys.choices(id, field), queryFn: ({ signal }) => api.getChoices(id, field, signal), staleTime: 0 });
}

export function useBillerRules(id: number) {
  return useQuery({ queryKey: queryKeys.billerRules(id), queryFn: ({ signal }) => api.getBillerRules(id, signal) });
}
