// Matching an email to one of the household's billers by who sent it: the
// email's first From address. A biller's full address beats any domain;
// between domains the most specific wins, so "mail.citywater.example" beats
// "citywater.example". A household's senders are unique, so there is never a
// tie.
//
// This trusts the From line, which a sender can forge. Checking the mail
// provider's verdict (the Authentication-Results header) is planned for
// before results go to OurHome.

import { domainToUnicode } from "node:url";
import type { Biller, BillerMatch } from "../shared/api.js";
import { isDomain, normalizeSender } from "../shared/billers.js";
import type { CapturedAddress } from "../shared/capture.js";

/** A domain in its readable form, so "xn--lec-cma.example" and "élec.example" compare equal. */
function readableDomain(domain: string): string {
  return domainToUnicode(domain) || domain;
}

/** A normalized sender (address or domain) with its domain in readable form. */
function readable(sender: string): string {
  const at = sender.lastIndexOf("@");
  return at === -1 ? readableDomain(sender) : `${sender.slice(0, at)}@${readableDomain(sender.slice(at + 1))}`;
}

export class BillerMatcher {
  private readonly addresses = new Map<string, BillerMatch>();
  private readonly domains = new Map<string, BillerMatch>();

  constructor(billers: readonly Biller[]) {
    for (const biller of billers) {
      for (const sender of biller.senders) {
        const match: BillerMatch = { id: biller.id, name: biller.name, kind: biller.kind, matchedOn: sender };
        (isDomain(sender) ? this.domains : this.addresses).set(readable(sender), match);
      }
    }
  }

  /** The biller for an email sent from `from`, or null. */
  match(from: readonly CapturedAddress[]): BillerMatch | null {
    const first = from.find((a) => a.address.trim() !== "");
    if (!first) return null;
    const address = readable(normalizeSender(first.address));
    const exact = this.addresses.get(address);
    if (exact) return exact;
    const at = address.lastIndexOf("@");
    if (at === -1) return null;
    // From the full domain up through its parents: a.b.example, b.example, example.
    let domain = address.slice(at + 1);
    for (;;) {
      const hit = this.domains.get(domain);
      if (hit) return hit;
      const dot = domain.indexOf(".");
      if (dot === -1) return null;
      domain = domain.slice(dot + 1);
    }
  }
}
