// The captured-email record, as saved in capture.json and sent by the API.
// Types only, so the web app can use them too.

export const CAPTURE_VERSION = 1;

export interface CapturedAddress {
  name: string;
  address: string;
}

/** One header line as received, folding kept. `name` is lower case. */
export interface CapturedHeader {
  name: string;
  line: string;
}

export interface CapturedAttachment {
  /** Where it is saved, relative to the message's folder. */
  file: string;
  /** The name the sender gave it, if any. Never used as a path. */
  filename: string | null;
  contentType: string;
  disposition: string | null;
  contentId: string | null;
  size: number;
  sha256: string;
}

export interface CapturedLink {
  url: string;
  /** The link's visible text (HTML links only). */
  text: string | null;
  /** Which body it was found in. */
  source: "html" | "text";
}

export interface Capture {
  version: typeof CAPTURE_VERSION;
  mailbox: string;
  folder: string;
  uidValidity: string;
  uid: number;
  capturedAt: string;
  raw: { file: "message.eml"; size: number; sha256: string };
  messageId: string | null;
  subject: string | null;
  date: string | null;
  from: CapturedAddress[];
  to: CapturedAddress[];
  cc: CapturedAddress[];
  replyTo: CapturedAddress[];
  headers: CapturedHeader[];
  /** The plain text body as sent, or null when the email has none or an empty one (never made up from the HTML). */
  text: string | null;
  /** The HTML body as sent, or null when the email has none or an empty one. Stored as text, never rendered. */
  html: string | null;
  attachments: CapturedAttachment[];
  links: CapturedLink[];
}
