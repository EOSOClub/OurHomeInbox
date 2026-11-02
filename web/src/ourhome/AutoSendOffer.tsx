// The popup offering Send automatically for a biller, shown when marking an
// email Checked completes the biller's run of CHECKS_BEFORE_AUTO clean checks
// (owner, 2026-11-01). Yes turns it on; Not now turns it down until another
// run; Escape closes it without choosing, so the next check asks again.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Send } from "lucide-react";
import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CHECKS_BEFORE_AUTO } from "../../../src/shared/handoff";
import { api } from "../api";
import { Button, Notice } from "../components/ui";
import { refreshAfterAutoSend } from "../queries";

export interface AutoSendCandidate {
  id: number;
  name: string;
}

function AutoSendDialog({ biller, onDone }: { biller: AutoSendCandidate; onDone: (message: string | null) => void }) {
  const queryClient = useQueryClient();
  const titleId = useId();
  const bodyId = useId();
  const choose = useMutation({
    mutationFn: (autoSend: boolean) => api.setAutoSend(biller.id, { autoSend }),
    onSuccess: (_saved, autoSend) => {
      refreshAfterAutoSend(queryClient);
      onDone(
        autoSend
          ? `${biller.name}'s emails now go to OurHome without a check.`
          : `Not now: ${biller.name}'s emails are still checked each time.`,
      );
    },
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDone(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onDone]);

  // Into the page's body, so no sticky bar or header it is opened from can sit over it.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={bodyId} className="w-full max-w-md rounded-lg border border-line bg-surface p-5 shadow-lg">
        <h2 id={titleId} className="flex items-center gap-2 text-lg font-semibold">
          <Send aria-hidden className="size-5 shrink-0 text-accent" />
          Send {biller.name}'s emails automatically?
        </h2>
        <div id={bodyId} className="mt-3 flex flex-col gap-2 text-sm">
          <p>
            The last {CHECKS_BEFORE_AUTO} of {biller.name}'s emails were checked and needed no fix. From now on, its emails can go to OurHome without anyone
            checking them.
          </p>
          <p className="text-muted">
            One that looks odd (a sender that is not verified, or a value picked out twice) still waits for a check. You can turn this off on {biller.name}'s
            page under Billers.
          </p>
        </div>
        {choose.isError ? (
          <Notice tone="error" live className="mt-3">
            Could not save that: {choose.error.message}
          </Notice>
        ) : null}
        <div className="mt-5 flex flex-wrap gap-2">
          {/* Focus starts here, inside the popup, so a keyboard or screen reader is in it at once. */}
          <Button autoFocus variant="primary" busy={choose.isPending && choose.variables === true} disabled={choose.isPending} onClick={() => choose.mutate(true)}>
            Yes, send automatically
          </Button>
          <Button variant="secondary" busy={choose.isPending && choose.variables === false} disabled={choose.isPending} onClick={() => choose.mutate(false)}>
            Not now
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted">Not now asks again after {CHECKS_BEFORE_AUTO} more checks with nothing to fix.</p>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Offers Send automatically for each biller handed to `offer`, one popup at a
 * time. `dialog` goes anywhere in the page; `message` says what was chosen.
 */
export function useAutoSendOffer(): { offer: (billers: readonly AutoSendCandidate[]) => void; dialog: ReactNode; message: string | null } {
  const [queue, setQueue] = useState<AutoSendCandidate[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const offer = useCallback((billers: readonly AutoSendCandidate[]) => {
    if (billers.length === 0) return;
    setQueue((now) => [...now, ...billers.filter((b) => !now.some((n) => n.id === b.id))]);
  }, []);
  const done = useCallback((said: string | null) => {
    if (said) setMessage(said);
    setQueue((now) => now.slice(1));
  }, []);
  const first = queue[0];
  return { offer, dialog: first ? <AutoSendDialog key={first.id} biller={first} onDone={done} /> : null, message };
}
