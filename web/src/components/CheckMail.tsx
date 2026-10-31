// "Check mail now", and keeping the page fresh when a read finishes: shared by
// Settings and Status.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useEffect, useRef } from "react";
import type { CheckingState } from "../../../src/shared/api";
import { api } from "../api";
import { queryKeys, refreshAfterMailboxChange } from "../queries";
import { Button, Notice } from "./ui";

/** When a read finishes (its finish time changes), the mail list, the mailboxes and the status are fetched again. */
export function useRefreshWhenReadFinishes(lastFinishedAt: string | null | undefined): void {
  const queryClient = useQueryClient();
  const seen = useRef(lastFinishedAt);
  useEffect(() => {
    if (lastFinishedAt && lastFinishedAt !== seen.current) refreshAfterMailboxChange(queryClient);
    seen.current = lastFinishedAt;
  }, [lastFinishedAt, queryClient]);
}

/** The button, busy while a read runs, with any error under it. */
export function CheckMailNow({ checking, disabled = false }: { checking: CheckingState; disabled?: boolean }) {
  const queryClient = useQueryClient();
  const check = useMutation({
    mutationFn: api.checkMail,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.mailboxes });
      void queryClient.invalidateQueries({ queryKey: queryKeys.status });
    },
  });
  return (
    <>
      <Button variant="secondary" className="px-3 py-1" busy={check.isPending || checking.running} disabled={disabled} onClick={() => check.mutate()}>
        <RefreshCw aria-hidden className="size-4" />
        Check mail now
      </Button>
      {check.isError ? (
        <Notice tone="error" live className="basis-full">
          {check.error.message}
        </Notice>
      ) : null}
    </>
  );
}
