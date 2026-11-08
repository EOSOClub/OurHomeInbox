// A reminder used as the bill (owner, 2026-11-07), in Picked out: the note a
// reminder shows (reminders are not sent to OurHome), or, once a person marked
// it as the bill, who did and when; and, on the email's page, the button to
// mark it or take the mark off (AsBillButton). When its biller's reminders are
// its bills (owner, 2026-11-08), the note says so and the page links to the
// biller, where that is turned off. See src/server/asBill.ts.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FileText, Settings2, Undo2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { AsBillMark, CaptureDetailResponse } from "../../../src/shared/api";
import type { EmailKind } from "../../../src/shared/extraction";
import { api } from "../api";
import { Button, Notice } from "../components/ui";
import { formatDateTime } from "../format";
import { refreshAfterAsBill } from "../queries";

/** "Marked by Sam Smith, Nov 7, 2026, 9:00 AM", or without the name when that account is gone. */
export function asBillLine(mark: AsBillMark): string {
  return `Marked${mark.by ? ` by ${mark.by}` : ""}, ${formatDateTime(mark.at)}`;
}

/**
 * What Picked out says about a reminder, or a reminder used as the bill.
 * Nothing for any other email. `action` is the page's button; without it the
 * note only explains.
 */
export function AsBillNotice({
  kind,
  asBill,
  byBiller = null,
  action,
}: {
  kind: EmailKind;
  asBill: AsBillMark | null;
  /** The biller's name when its reminders are its bills and this one is used so. */
  byBiller?: string | null;
  action?: ReactNode;
}) {
  if (byBiller !== null) {
    return (
      <Notice tone="info">
        <span className="block">
          Used as the bill: <span className="wrap-anywhere">{byBiller}</span> sends its bills as reminders (set on the biller's page). It
          is treated like any other bill: its payment can pay it, and it goes to OurHome with the usual checks.
        </span>
        {action}
      </Notice>
    );
  }
  if (asBill) {
    return (
      <Notice tone="info">
        <span className="block">
          Used as the bill. {asBillLine(asBill)}. It is treated like any other bill: its payment can pay it, and it goes to OurHome
          with the usual checks.
        </span>
        {action}
      </Notice>
    );
  }
  if (kind !== "reminder") return null;
  return (
    <Notice tone="info">
      <span className="block">
        A reminder of a bill already sent. Reminders are not sent to OurHome, so the bill is not counted twice.
        {action ? " If the bill's own email never came in, or this biller sends its bills as reminders, use this reminder as the bill." : ""}
      </span>
      {action}
    </Notice>
  );
}

/** The link to the biller's page, where "Its reminders are its bills" is set. */
function BillerSettingLink({ id, children }: { id: number; children: ReactNode }) {
  return (
    <Link to={`/billers/${id}`} className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline">
      <Settings2 aria-hidden className="size-4 shrink-0" />
      {children}
    </Link>
  );
}

/**
 * On an email's page: Use as the bill on a reminder, or It is only a reminder
 * once it is used as the bill, with a link to set it for all of the biller's
 * reminders. When the biller's setting already uses it as the bill, only the
 * link to change that.
 */
export function AsBillButton({ detail }: { detail: CaptureDetailResponse }) {
  const queryClient = useQueryClient();
  const [done, setDone] = useState("");
  const marked = detail.asBill !== null;
  const { biller } = detail;
  const change = useMutation({
    mutationFn: (asBill: boolean) => api.setAsBill(detail.id, { asBill }),
    // Waits for the emails to come back, so the page never shows the old kind after the button.
    onSuccess: async (_result, asBill) => {
      await refreshAfterAsBill(queryClient);
      setDone(asBill ? "Used as the bill." : "It is a reminder again.");
    },
  });
  if (detail.asBillByBiller && biller) {
    return (
      <div className="mt-2">
        <BillerSettingLink id={biller.id}>Change it on the biller's page</BillerSettingLink>
      </div>
    );
  }
  if (!marked && detail.extraction.kind !== "reminder") return null;

  function mark(asBill: boolean) {
    setDone("");
    change.mutate(asBill);
  }

  return (
    <div className="mt-2 flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {marked ? (
          <Button variant="quiet" className="px-3 py-1" disabled={change.isPending} onClick={() => mark(false)}>
            <Undo2 aria-hidden className="size-4" />
            It is only a reminder
          </Button>
        ) : (
          <Button variant="secondary" className="px-3 py-1" disabled={change.isPending} onClick={() => mark(true)}>
            <FileText aria-hidden className="size-4" />
            Use as the bill
          </Button>
        )}
      </div>
      {biller ? (
        <BillerSettingLink id={biller.id}>
          Use every <span className="wrap-anywhere">{biller.name}</span> reminder as its bill
        </BillerSettingLink>
      ) : null}
      {change.isError ? (
        <Notice tone="error" live>
          Could not change it: {change.error.message}
        </Notice>
      ) : null}
      {/* Always there, so a screen reader hears each change. */}
      <p role="status" className="sr-only">
        {change.isError ? "" : done}
      </p>
    </div>
  );
}
