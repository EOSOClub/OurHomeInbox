import { describe, expect, it } from "vitest";
import type { MailboxConfig } from "../src/config.js";
import { explainConnectError, missingFolderMessage, SECURITY_OPTIONS } from "../src/mailbox.js";

describe("missingFolderMessage", () => {
  const folders = ["INBOX", "Folders/Personal", "Folders/Personal/Finance/Bills", "Folders/Games", "Labels/Bill"];

  it("suggests the same path under Proton's Folders/ instead of listing everything", () => {
    const message = missingFolderMessage("Personal/Finance/Bills", folders);
    expect(message).toContain('Did you mean "Folders/Personal/Finance/Bills"?');
    expect(message).not.toContain("Folders/Games");
  });

  it("suggests a match in different capitalization", () => {
    expect(missingFolderMessage("labels/bill", folders)).toContain('Did you mean "Labels/Bill"?');
  });

  it("does not suggest a folder that only shares the end of a name", () => {
    expect(missingFolderMessage("ills", folders)).toContain("Folders in this mailbox:");
  });

  it("lists every folder, sorted, when nothing is close", () => {
    expect(missingFolderMessage("Utilities", folders)).toBe(
      'There is no folder called "Utilities". Folders in this mailbox: Folders/Games, Folders/Personal, Folders/Personal/Finance/Bills, INBOX, Labels/Bill',
    );
  });
});

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
  const explain = (err: object) => explainConnectError(mailbox, Object.assign(new Error("raw"), err), false).message;

  it.each(["127.0.0.1", "localhost"])("inside Docker, explains that %s is the container itself", (host) => {
    const local = { ...mailbox, imap: { ...mailbox.imap, host } };
    const message = explainConnectError(local, Object.assign(new Error("raw"), { code: "ECONNREFUSED" }), true).message;
    expect(message).toContain("host.docker.internal");
  });

  it("outside Docker, 127.0.0.1 gets the normal message", () => {
    const local = { ...mailbox, imap: { ...mailbox.imap, host: "127.0.0.1" } };
    const message = explainConnectError(local, Object.assign(new Error("raw"), { code: "ECONNREFUSED" }), false).message;
    expect(message).toContain("refused the connection");
  });

  it("says when STARTTLS was required but not possible", () => {
    expect(explain({ tlsFailed: true })).toContain("could not switch to an encrypted connection");
  });

  it("blames the certificate, not the server, when a STARTTLS upgrade fails on it", () => {
    // What imapflow throws for the Proton Bridge reached by name with security: starttls.
    const message = explain({ tlsFailed: true, code: "ERR_TLS_CERT_ALTNAME_INVALID" });
    expect(message).toContain("certificate that cannot be trusted");
    expect(message).not.toContain("could not switch");
  });

  it("explains the certificate in plain words, not Node's text", () => {
    const message = explainConnectError(
      mailbox,
      Object.assign(new Error("self-signed certificate; try running Node.js with --use-system-ca"), {
        code: "DEPTH_ZERO_SELF_SIGNED_CERT",
      }),
      false,
    ).message;
    expect(message).toContain("it is self-signed");
    expect(message).not.toContain("Node.js");
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
