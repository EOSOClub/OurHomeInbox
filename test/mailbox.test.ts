import { describe, expect, it } from "vitest";
import type { MailboxConfig } from "../src/config.js";
import { explainConnectError, SECURITY_OPTIONS } from "../src/mailbox.js";

describe("SECURITY_OPTIONS", () => {
  it("none never upgrades, even when the server offers STARTTLS", () => {
    expect(SECURITY_OPTIONS.none).toEqual({ secure: false, doSTARTTLS: false });
  });

  it("starttls requires the upgrade instead of carrying on unencrypted", () => {
    expect(SECURITY_OPTIONS.starttls).toEqual({ secure: false, doSTARTTLS: true });
  });

  it("tls is encrypted from the start", () => {
    expect(SECURITY_OPTIONS.tls).toEqual({ secure: true, doSTARTTLS: undefined });
  });
});

describe("explainConnectError", () => {
  const mailbox: MailboxConfig = {
    name: "Proton bills",
    provider: "proton-bridge",
    imap: { host: "protonmail-bridge", port: 993, security: "tls", username: "me@proton.me", password: "x" },
    folder: "INBOX",
  };
  const explain = (err: object) => explainConnectError(mailbox, Object.assign(new Error("raw"), err)).message;

  it("says when STARTTLS was required but not possible", () => {
    expect(explain({ tlsFailed: true })).toContain("could not switch to an encrypted connection");
  });

  it("says when tls was used on a port that is not encrypted", () => {
    expect(explain({ code: "ERR_SSL_WRONG_VERSION_NUMBER" })).toContain("tls is usually port 993");
  });

  it.each(["CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "ERR_TLS_CERT_ALTNAME_INVALID"])(
    "explains an untrusted certificate (%s) with the Bridge hint",
    (code) => {
      const message = explain({ code });
      expect(message).toContain("certificate that cannot be trusted");
      expect(message).toContain("use security: none");
    },
  );

  it("says when the login is refused", () => {
    expect(explain({ authenticationFailed: true })).toContain("did not accept the username or password");
  });

  it("says when the server cannot be found", () => {
    expect(explain({ code: "ENOTFOUND" })).toContain("Could not find protonmail-bridge");
  });
});
