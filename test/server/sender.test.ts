// The sender check, on header layouts copied from the Bridge's real emails
// (the values here are made up).

import { describe, expect, it } from "vitest";
import { checkSender, parseAuthResults } from "../../src/server/sender.js";
import type { CapturedAddress, CapturedHeader } from "../../src/shared/capture.js";

const h = (line: string): CapturedHeader => ({ name: line.slice(0, line.indexOf(":")).toLowerCase(), line });

const RECEIVED = [h("Received: from mail.example (mail.example [192.0.2.1])\r\n\tby mailin.protonmail.ch"), h("Received: by mailin.protonmail.ch")];

/** Proton's block of verdicts, as the Bridge gives it: right under its Received lines. */
function proton(dmarc: string, from = "wm.com"): CapturedHeader[] {
  return [
    h(`Authentication-Results: mail.protonmail.ch; dmarc=${dmarc} (p=reject dis=none) header.from=${from}`),
    h("Authentication-Results: mail.protonmail.ch; spf=pass smtp.mailfrom=mgi5.wm.com"),
    h("Authentication-Results: mail.protonmail.ch; arc=none smtp.remote-ip=192.0.2.1"),
    h(`Authentication-Results: mail.protonmail.ch; dkim=pass (1024-bit key) header.d=${from} header.i=@${from} header.b="QsOq"`),
  ];
}

/** An email: the Bridge's own headers, then Proton's, then `rest` (the sender's own). */
function email(block: CapturedHeader[], rest: CapturedHeader[] = [], address = "noreply@wm.com") {
  const headers = [h("X-Pm-Gluon-Id: 1"), h("Content-Type: text/html"), h("From: WM <noreply@wm.com>"), h("Return-Path: <b@mgi5.wm.com>"), ...RECEIVED, ...block, h("DKIM-Signature: v=1; d=wm.com"), ...rest];
  const from: CapturedAddress[] = address ? [{ name: "WM", address }] : [];
  return { headers, from };
}

describe("checkSender", () => {
  it("trusts Proton's own verdict for the From address's domain", () => {
    expect(checkSender(email(proton("pass")))).toEqual({
      verified: true,
      outcome: "verified",
      domain: "wm.com",
      result: "pass",
      reason: "Proton checked that this email really comes from wm.com.",
    });
  });

  it("matches the From address's exact domain, a subdomain included, ignoring case", () => {
    const sub = email(proton("PASS", "Account.XcelEnergy.com")), address = "NoReply@account.xcelenergy.com";
    expect(checkSender({ ...sub, from: [{ name: "", address }] })).toMatchObject({ verified: true, domain: "account.xcelenergy.com" });
  });

  it("says when Proton's check failed, as with the city's emails sent through another company", () => {
    const check = checkSender(email(proton("fail", "siouxfalls.org"), [], "noreply@siouxfalls.org"));
    expect(check).toMatchObject({ verified: false, outcome: "failed", domain: "siouxfalls.org", result: "fail" });
    expect(check.reason).toContain('its check says "fail"');
  });

  it("does not count a pass for a different domain than the From address shows", () => {
    const check = checkSender(email(proton("pass", "evil.example")));
    expect(check).toMatchObject({ verified: false, outcome: "mismatch", domain: "wm.com" });
    expect(check.reason).toBe("Proton checked evil.example, but this email shows it is from wm.com.");
  });

  it("does not let a parent domain stand in for the From address's own", () => {
    const check = checkSender({ ...email(proton("pass", "xcelenergy.com")), from: [{ name: "", address: "a@account.xcelenergy.com" }] });
    expect(check.outcome).toBe("mismatch");
  });

  it("says when there is no verdict, or no address to check", () => {
    expect(checkSender(email([]))).toMatchObject({ verified: false, outcome: "missing", domain: "wm.com" });
    expect(checkSender(email(proton("pass"), [], ""))).toMatchObject({ verified: false, outcome: "missing", domain: null });
  });

  it("distrusts the email when a verdict in Proton's name is planted among the sender's headers", () => {
    const planted = h("Authentication-Results: mail.protonmail.ch; dmarc=pass header.from=wm.com");
    expect(checkSender(email(proton("fail"), [planted]))).toMatchObject({ verified: false, outcome: "planted" });
  });

  it("distrusts a verdict in Proton's name that is not under Proton's Received lines", () => {
    const headers = [h("From: WM <noreply@wm.com>"), h("Authentication-Results: mail.protonmail.ch; dmarc=pass header.from=wm.com"), h("Subject: Hi")];
    expect(checkSender({ headers, from: [{ name: "WM", address: "noreply@wm.com" }] })).toMatchObject({ verified: false, outcome: "planted" });
  });

  it("ignores verdicts other servers wrote along the way", () => {
    const other = h("Authentication-Results: mx.other.example; dmarc=fail header.from=wm.com");
    expect(checkSender(email(proton("pass"), [other]))).toMatchObject({ verified: true });
  });

  it("fails when any of Proton's DMARC verdicts is not a pass", () => {
    const block = [...proton("pass"), h("Authentication-Results: mail.protonmail.ch; dmarc=none header.from=wm.com")];
    expect(checkSender(email(block))).toMatchObject({ verified: false, outcome: "failed", result: "none" });
  });
});

describe("parseAuthResults", () => {
  it("reads folded lines, a version number, comments and several results", () => {
    const parsed = parseAuthResults(
      h('Authentication-Results: mail.protonmail.ch 1;\r\n\tdmarc=pass (p=quarantine; dis=none)\r\n header.from=emails.midco.com; dkim=pass header.d=midco.com header.b="a;b"'),
    );
    expect(parsed).toEqual({
      authservId: "mail.protonmail.ch",
      results: [
        { method: "dmarc", result: "pass", props: { "header.from": "emails.midco.com" } },
        { method: "dkim", result: "pass", props: { "header.d": "midco.com", "header.b": "a;b" } },
      ],
    });
  });

  it("is null for another header or an empty one", () => {
    expect(parseAuthResults(h("Received: by mailin.protonmail.ch"))).toBeNull();
    expect(parseAuthResults(h("Authentication-Results: "))).toBeNull();
  });
});
