// Loads the two settings files every setup has:
//   .env        secrets (passwords, tokens). Never committed. See .env.example.
//   config.yml  everything else a household might change. See config.example.yml.
// Docker passes .env in as environment variables and mounts config.yml, so the
// same code reads both inside and outside a container.

import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { parse as parseYaml, YAMLParseError } from "yaml";
import { z } from "zod";

/** Used when OURHOMEINBOX_CONFIG is not set. Docker sets it to /app/config.yml. */
export const DEFAULT_CONFIG_PATH = "config.yml";

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

// .strict() turns a misspelt setting into an error instead of silently ignoring it.
// Every connection value is required: nothing about the connection is implied.
const imapSchema = z
  .object({
    host: z.string().trim().min(1),
    port: z.number().int().min(1).max(65535),
    // Any capitalization, since mail apps write it "STARTTLS" or "None".
    security: z.preprocess((value) => (typeof value === "string" ? value.trim().toLowerCase() : value), z.enum(SECURITY_MODES)),
    username: z.string().trim().min(1),
    password_env: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/, "must be an .env name in capitals, like PROTON_BRIDGE_PASSWORD"),
  })
  .strict();

const mailboxSchema = z
  .object({
    name: z.string().trim().min(1),
    provider: z.enum(PROVIDERS),
    imap: imapSchema,
    folder: z.string().trim().min(1).default("INBOX"),
  })
  .strict();

const fileSchema = z
  .object({
    log_level: z.enum(LOG_LEVELS).default("info"),
    mailboxes: z
      .array(mailboxSchema)
      .min(1, "add at least one mailbox")
      .refine((list) => new Set(list.map((m) => m.name)).size === list.length, "each mailbox needs its own name")
      .refine((list) => list.every((m) => mailboxSlug(m.name) !== ""), "a mailbox name needs at least one letter or number")
      .refine(
        (list) => new Set(list.map((m) => mailboxSlug(m.name))).size === list.length,
        "mailbox names must differ by more than capitals, spaces and punctuation, since each gets its own data folder",
      ),
    // Read by docker/deploy.sh for Docker Compose, not by the app. Checked here
    // so a typo in it is caught the same way as anywhere else.
    docker: z
      .object({
        network: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, "must be a Docker network name, like ourhome_net")
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export interface ImapConfig {
  host: string;
  port: number;
  security: Security;
  username: string;
  password: string;
}

export interface MailboxConfig {
  name: string;
  provider: Provider;
  imap: ImapConfig;
  folder: string;
}

export interface Config {
  logLevel: LogLevel;
  mailboxes: MailboxConfig[];
}

/** The folder name a mailbox's captured mail is kept under: "Proton bills" -> "proton-bills". */
export function mailboxSlug(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "") // accents NFKD split off: "É" -> "E"
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** A settings problem the person running OurHomeInbox can fix. Each problem is one line. */
export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join("\n"));
    this.name = "ConfigError";
  }
}

/**
 * Reads a .env file into `env` when one exists, for running outside Docker.
 * Values already set win, so Docker's environment is never overridden.
 */
export function loadDotEnv(path = ".env", env: NodeJS.ProcessEnv = process.env): void {
  if (!existsSync(path)) return;
  for (const [key, value] of Object.entries(parseEnv(readFileSync(path, "utf8")))) {
    if (env[key] === undefined) env[key] = value;
  }
}

/** Reads config.yml, checks it, and fills in each mailbox's IMAP password from the environment. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const path = env.OURHOMEINBOX_CONFIG || DEFAULT_CONFIG_PATH;
  if (!existsSync(path)) {
    throw new ConfigError([`No settings file at ${path}. Copy config.example.yml to config.yml and fill it in.`]);
  }

  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, "utf8"));
  } catch (err) {
    if (err instanceof YAMLParseError) throw new ConfigError([`${path} is not valid YAML: ${err.message}`]);
    throw err;
  }

  const parsed = fileSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((issue) => `${path}: ${formatPath(issue.path)}: ${issue.message}`));
  }

  const problems: string[] = [];
  const mailboxes = parsed.data.mailboxes.map((mailbox): MailboxConfig => {
    const { password_env, ...imap } = mailbox.imap;
    const password = env[password_env] ?? "";
    if (password === "") {
      problems.push(`${password_env} is empty or missing in .env (the IMAP password for mailbox "${mailbox.name}").`);
    }
    return {
      name: mailbox.name,
      provider: mailbox.provider,
      imap: { ...imap, password },
      folder: mailbox.folder,
    };
  });
  if (problems.length > 0) throw new ConfigError(problems);

  return { logLevel: parsed.data.log_level, mailboxes };
}

/** `["mailboxes", 0, "username"]` -> `mailboxes[0].username` */
function formatPath(path: PropertyKey[]): string {
  if (path.length === 0) return "(whole file)";
  return path
    .map((part, i) => (typeof part === "number" ? `[${part}]` : `${i === 0 ? "" : "."}${String(part)}`))
    .join("");
}
