// On a biller's page: whether its emails go to OurHome by themselves (Send
// automatically) or wait for a check, how far its run of clean checks has got,
// and the button to turn it off, or on once the run has earned it (owner,
// 2026-11-01: at first a person checks each email).

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Send } from "lucide-react";
import type { Biller } from "../../../src/shared/api";
import { CHECKS_BEFORE_AUTO } from "../../../src/shared/handoff";
import { api } from "../api";
import { Button, Card, Notice } from "../components/ui";
import { refreshAfterAutoSend } from "../queries";

export function BillerAutoSend({ biller }: { biller: Biller }) {
  const queryClient = useQueryClient();
  const change = useMutation({
    mutationFn: (autoSend: boolean) => api.setAutoSend(biller.id, { autoSend }),
    onSuccess: () => refreshAfterAutoSend(queryClient),
  });
  const earned = biller.cleanChecks >= CHECKS_BEFORE_AUTO;
  const name = <span className="wrap-anywhere">{biller.name}</span>;

  return (
    <Card>
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        <Send aria-hidden className="size-5 shrink-0" />
        Sending to OurHome
      </h2>
      {biller.autoSend ? (
        <>
          <p className="mt-1">
            <span className="font-medium">Sent automatically.</span> {name}'s emails go to OurHome without a check.
          </p>
          <p className="mt-1 text-sm text-muted">One that looks odd (a sender that is not verified, or a value picked out twice) still waits for someone to check it.</p>
        </>
      ) : (
        <>
          <p className="mt-1">
            <span className="font-medium">Checked each time.</span> Each of {name}'s emails waits for someone to mark it Checked before it goes to OurHome.
          </p>
          <p className="mt-1 text-sm text-muted">
            After {CHECKS_BEFORE_AUTO} in a row are checked with nothing to fix, OurHomeInbox offers to send them automatically.{" "}
            {earned ? "That has happened." : `${biller.cleanChecks} of ${CHECKS_BEFORE_AUTO} so far.`}
          </p>
        </>
      )}
      {change.isError ? (
        <Notice tone="error" live className="mt-3">
          Could not change it: {change.error.message}
        </Notice>
      ) : null}
      {biller.autoSend || earned ? (
        <div className="mt-3">
          <Button variant="secondary" className="px-3 py-1.5" busy={change.isPending} onClick={() => change.mutate(!biller.autoSend)}>
            {biller.autoSend ? "Check each email again" : "Send automatically"}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
