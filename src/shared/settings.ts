// The choices settings are made from, shared by the server (which checks
// them) and the web app (which offers them).

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const PROVIDERS = ["proton-bridge"] as const;
export type Provider = (typeof PROVIDERS)[number];

/**
 * How an IMAP connection is protected:
 *   none      no encryption at all
 *   starttls  connects unencrypted, then must switch to encryption (STARTTLS)
 *   tls       encrypted from the first byte ("SSL/TLS" in most mail apps)
 */
export const SECURITY_MODES = ["none", "starttls", "tls"] as const;
export type Security = (typeof SECURITY_MODES)[number];

/** How often mail may be read, in minutes: at least every minute, at most once a day. */
export const MIN_CAPTURE_MINUTES = 1;
export const MAX_CAPTURE_MINUTES = 1440;

export const MAX_MAILBOX_NAME = 100;
export const MAX_MAILBOX_FOLDER = 300;
export const MAX_MAILBOX_HOST = 253;
export const MAX_MAILBOX_USERNAME = 320;
export const MAX_MAILBOX_PASSWORD = 1000;
