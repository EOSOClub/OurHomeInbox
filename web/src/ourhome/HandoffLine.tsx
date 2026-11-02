// An email's place in the hand-off to OurHome, for its page: whether it goes,
// waits for a person, or is not for OurHome, why, and what OurHome has.

import { CircleCheck, CircleSlash, Clock, Send } from "lucide-react";
import type { ReactNode } from "react";
import type { HandoffInfo } from "../../../src/shared/handoff";
import { formatDateTime } from "../format";

function headline(handoff: HandoffInfo): { text: string; icon: ReactNode; tone: string } {
  const { state, connected, offered } = handoff;
  if (state === "never") return { text: "Not for OurHome", icon: <CircleSlash aria-hidden className="size-4 shrink-0" />, tone: "" };
  if (state === "waits") return { text: "Waits before going to OurHome", icon: <Clock aria-hidden className="size-4 shrink-0" />, tone: "text-warn" };
  if (!connected) return { text: "Ready for OurHome", icon: <Send aria-hidden className="size-4 shrink-0" />, tone: "" };
  if (offered?.status === "ready" && offered.taken) return { text: "OurHome has it", icon: <CircleCheck aria-hidden className="size-4 shrink-0 text-accent" />, tone: "" };
  if (offered?.status === "ready") return { text: "Offered to OurHome", icon: <Send aria-hidden className="size-4 shrink-0" />, tone: "" };
  return { text: "Goes to OurHome", icon: <Send aria-hidden className="size-4 shrink-0" />, tone: "" };
}

/** What a person should know beyond the reason: when it was offered, taken back, or that OurHome is not connected. */
function note(handoff: HandoffInfo): ReactNode {
  const { state, connected, offered } = handoff;
  if (offered?.status === "withdrawn") return `Taken back from OurHome on ${formatDateTime(offered.at)}.`;
  // Waiting holds back only what is new: OurHome keeps what it was already offered.
  if (state === "waits" && offered?.status === "ready") return `OurHome keeps what it was offered on ${formatDateTime(offered.at)}; any change waits.`;
  if (state !== "goes") return null;
  // Words, not a link: the email's view is shown without the router.
  if (!connected) return "It goes once OurHome is connected (Settings, OurHome connection).";
  if (offered?.status === "ready") {
    return offered.taken ? `Offered on ${formatDateTime(offered.at)}.` : `Offered on ${formatDateTime(offered.at)}; OurHome takes it the next time it asks.`;
  }
  return "OurHome takes it the next time it asks.";
}

export function HandoffSummary({ handoff }: { handoff: HandoffInfo }) {
  const { text, icon, tone } = headline(handoff);
  const extra = note(handoff);
  return (
    <>
      <span className={`flex items-center gap-1.5 font-medium ${tone}`}>
        {icon}
        {text}
      </span>
      <span className="block text-sm text-muted">{handoff.reason}</span>
      {extra ? <span className="block text-sm text-muted">{extra}</span> : null}
    </>
  );
}
