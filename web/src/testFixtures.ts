// Values the page tests share when they build the server's replies by hand.

import type { HandoffInfo } from "../../src/shared/handoff";

/** An email's hand-off line as the server gives it with no OurHome connection and no biller. */
export const HANDOFF_WAITS: HandoffInfo = {
  state: "waits",
  reason: "Waits for someone to mark it Checked: its sender is not one of your billers.",
  connected: false,
  offered: null,
};
