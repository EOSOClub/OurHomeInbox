// The sender check: does an email really come from the domain its From
// address shows? Proton checks every email from outside when it arrives
// (DMARC: the domain's own published rules for who may send in its name) and
// writes the verdict into the email as Authentication-Results headers naming
// itself, mail.protonmail.ch. Nothing here contacts anyone; it only reads
// those headers.
//
// Anyone can write an Authentication-Results header into an email they send,
// so only Proton's own block counts: the run of them directly under Proton's
// Received lines, at the top. In every captured email the Bridge gives that
// block before the sender's own headers. A verdict in Proton's name anywhere
// else means someone planted one, and the email is not trusted.

import type { CapturedAddress, CapturedHeader } from "../shared/capture.js";
import type { SenderCheck } from "../shared/sender.js";

/** The name Proton signs its verdicts with. Other providers will add theirs. */
export const PROTON_AUTHSERV_ID = "mail.protonmail.ch";

interface AuthResults {
  /** Who wrote it, lower case. */
  authservId: string;
  /** Each method's result and properties: "dmarc" -> { result: "pass", props: { "header.from": "wm.com" } }. */
  results: Array<{ method: string; result: string; props: Record<string, string> }>;
}

/** Removes (comments), innermost first, so "(p=reject dis=none)" does not read as a property. */
function dropComments(text: string): string {
  let previous: string;
  do {
    previous = text;
    text = text.replace(/\([^()]*\)/g, " ");
  } while (text !== previous);
  return text;
}

/** Reads one Authentication-Results header (RFC 8601), or null when it is not one. */
export function parseAuthResults(header: CapturedHeader): AuthResults | null {
  if (header.name !== "authentication-results") return null;
  const unfolded = header.line.replace(/\r?\n[ \t]+/g, " ");
  const colon = unfolded.indexOf(":");
  if (colon === -1) return null;
  // Split on the semicolons between results, never one inside a "quoted" value.
  const [first, ...rest] = dropComments(unfolded.slice(colon + 1)).match(/(?:[^;"]|"[^"]*")+/g) ?? [];
  // "mail.protonmail.ch" or "mail.protonmail.ch 1" (a version).
  const authservId = (first ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (authservId === "") return null;
  const results: AuthResults["results"] = [];
  for (const part of rest) {
    const words = part.trim().split(/\s+/).filter(Boolean);
    const head = /^([a-z0-9_-]+)=([a-z0-9_-]+)$/i.exec(words[0] ?? "");
    if (!head) continue;
    const props: Record<string, string> = {};
    for (const word of words.slice(1)) {
      const prop = /^([a-z0-9_-]+\.[a-z0-9_-]+)=(.*)$/i.exec(word);
      if (prop) props[prop[1]!.toLowerCase()] = prop[2]!.replace(/^"|"$/g, "");
    }
    results.push({ method: head[1]!.toLowerCase(), result: head[2]!.toLowerCase(), props });
  }
  return { authservId, results };
}

/** The domain of the first From address that has one, lower case, without a trailing dot. */
function fromDomain(from: readonly CapturedAddress[]): string | null {
  const address = from.find((a) => a.address.trim() !== "")?.address.trim().toLowerCase();
  const at = address?.lastIndexOf("@") ?? -1;
  if (!address || at === -1 || at === address.length - 1) return null;
  return address.slice(at + 1).replace(/\.$/, "");
}

/** Checks one email by its headers and From address, as Proton judged it. */
export function checkSender(capture: { headers: readonly CapturedHeader[]; from: readonly CapturedAddress[] }): SenderCheck {
  const domain = fromDomain(capture.from);
  const { headers } = capture;
  const missing = (reason: string): SenderCheck => ({ verified: false, outcome: "missing", domain, result: null, reason });

  // Proton's block: the first run of Authentication-Results, directly under a Received line.
  const start = headers.findIndex((h) => h.name === "authentication-results");
  const underReceived = start > 0 && headers[start - 1]!.name === "received";
  let end = start;
  if (underReceived) while (end < headers.length && headers[end]!.name === "authentication-results") end += 1;
  const inBlock = (index: number) => underReceived && index >= start && index < end;
  const isProtons = (results: AuthResults | null) => results?.authservId === PROTON_AUTHSERV_ID;

  if (headers.some((h, i) => !inBlock(i) && isProtons(parseAuthResults(h)))) {
    return {
      verified: false,
      outcome: "planted",
      domain,
      result: null,
      reason: "This email carries a check result in Proton's name outside the place Proton puts its own, so who sent it is not trusted.",
    };
  }
  const block = underReceived ? headers.slice(start, end).map(parseAuthResults) : [];

  const dmarc = block.filter(isProtons).flatMap((results) => results!.results.filter((r) => r.method === "dmarc"));
  if (domain === null) return missing("This email has no sender address to check.");
  if (dmarc.length === 0) return missing("Proton left no verdict on this email, so who sent it cannot be checked.");

  const failed = dmarc.find((r) => r.result !== "pass");
  if (failed) {
    return {
      verified: false,
      outcome: "failed",
      domain,
      result: failed.result,
      reason: `Proton could not confirm this email comes from ${domain}: its check says "${failed.result}". Some billers send through other companies and fail this check, so look at it before trusting it.`,
    };
  }
  const other = dmarc.map((r) => (r.props["header.from"] ?? "").toLowerCase().replace(/\.$/, "")).find((checked) => checked !== domain);
  if (other !== undefined) {
    return {
      verified: false,
      outcome: "mismatch",
      domain,
      result: "pass",
      reason: `Proton checked ${other || "no address"}, but this email shows it is from ${domain}.`,
    };
  }
  return { verified: true, outcome: "verified", domain, result: "pass", reason: `Proton checked that this email really comes from ${domain}.` };
}
