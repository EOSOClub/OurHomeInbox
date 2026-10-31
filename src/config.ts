// Loads the two settings files every setup has:
//   .env        secrets (passwords, tokens). Never committed. See .env.example.
//   config.yml  the install's settings: how often mail is read, the log level,
//               the web port and Docker's. See config.example.yml.
// Docker passes .env in as environment variables and mounts config.yml, so the
// same code reads both inside and outside a container.
//
// Mailboxes belong to a household and live in the database (server/mailboxes.ts).
// Mailboxes listed in config.yml (as docker/deploy.sh writes the first one)
// are copied into the database once, with their passwords from .env, and are
// not read after that.
//
// The web page changes config.yml through updateConfigFile, which keeps the
// file's comments and layout and checks the result before writing it.

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { parse as parseYaml, parseDocument, YAMLParseError } from "yaml";
import { z } from "zod";

/** Used when OURHOMEINBOX_CONFIG is not set. Docker sets it to /app/config.yml. */
export const DEFAULT_CONFIG_PATH = "config.yml";

export const DEFAULT_WEB_PORT = 8080;
export const DEFAULT_CAPTURE_MINUTES = 15;

// The choices live in shared/settings.ts, so the web app offers the same ones.
import { LOG_LEVELS, MAX_CAPTURE_MINUTES, MIN_CAPTURE_MINUTES, PROVIDERS, SECURITY_MODES, type LogLevel, type Provider, type Security } from "./shared/settings.js";

export { LOG_LEVELS, PROVIDERS, SECURITY_MODES, type LogLevel, type Provider, type Security };

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
    // Copied into the database once (see the top of this file); none is fine.
    mailboxes: z
      .array(mailboxSchema)
      .default([])
      .refine((list) => new Set(list.map((m) => m.name)).size === list.length, "each mailbox needs its own name")
      .refine((list) => list.every((m) => mailboxSlug(m.name) !== ""), "a mailbox name needs at least one letter or number")
      .refine(
        (list) => new Set(list.map((m) => mailboxSlug(m.name))).size === list.length,
        "mailbox names must differ by more than capitals, spaces and punctuation, since each gets its own data folder",
      ),
    web: z
      .object({ port: z.number().int().min(1).max(65535).default(DEFAULT_WEB_PORT) })
      .strict()
      .default({ port: DEFAULT_WEB_PORT }),
    capture: z
      .object({ every_minutes: z.number().int().min(MIN_CAPTURE_MINUTES).max(MAX_CAPTURE_MINUTES).default(DEFAULT_CAPTURE_MINUTES) })
      .strict()
      .default({ every_minutes: DEFAULT_CAPTURE_MINUTES }),
    // Read by docker/deploy.sh for Docker Compose, not by the app. Checked here
    // so a typo in it is caught the same way as anywhere else.
    docker: z
      .object({
        network: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, "must be a Docker network name, like ourhome_net")
          .optional(),
        port: z.number().int().min(1).max(65535).optional(),
        bind: z.ipv4("must be an address like 127.0.0.1 (this computer only) or 0.0.0.0 (your network)").optional(),
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
  /** The .env line the password came from. */
  passwordEnv: string;
  /** Empty when that line is missing or empty. */
  password: string;
}

/** A mailbox as written in config.yml: only read once, to copy it into the database. */
export interface MailboxConfig {
  name: string;
  provider: Provider;
  imap: ImapConfig;
  folder: string;
}

export interface DockerConfig {
  network?: string;
  port?: number;
  bind?: string;
}

export interface Config {
  logLevel: LogLevel;
  /** Mailboxes listed in config.yml, copied into the database once (see the top of this file). */
  mailboxes: MailboxConfig[];
  web: { port: number };
  capture: { everyMinutes: number };
  /** Read by docker/deploy.sh; shown, never used by the app. */
  docker: DockerConfig | null;
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

/** Where config.yml is: OURHOMEINBOX_CONFIG (Docker sets /app/config.yml), else ./config.yml. */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.OURHOMEINBOX_CONFIG || DEFAULT_CONFIG_PATH;
}

function readYaml(path: string): unknown {
  if (!existsSync(path)) {
    throw new ConfigError([`No settings file at ${path}. Copy config.example.yml to config.yml and fill it in.`]);
  }
  try {
    return parseYaml(readFileSync(path, "utf8"));
  } catch (err) {
    if (err instanceof YAMLParseError) throw new ConfigError([`${path} is not valid YAML: ${err.message}`]);
    throw err;
  }
}

function checkFile(raw: unknown, path: string): z.output<typeof fileSchema> {
  const parsed = fileSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((issue) => `${path}: ${formatPath(issue.path)}: ${issue.message}`));
  }
  return parsed.data;
}

/**
 * Reads config.yml and checks it. Each listed mailbox gets its IMAP password
 * from the environment; a missing one is left empty, to be set on the web page.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const path = configPath(env);
  const file = checkFile(readYaml(path), path);
  const mailboxes = file.mailboxes.map((mailbox): MailboxConfig => {
    const { password_env, ...imap } = mailbox.imap;
    return {
      name: mailbox.name,
      provider: mailbox.provider,
      imap: { ...imap, passwordEnv: password_env, password: env[password_env] ?? "" },
      folder: mailbox.folder,
    };
  });
  return {
    logLevel: file.log_level,
    mailboxes,
    web: { port: file.web.port },
    capture: { everyMinutes: file.capture.every_minutes },
    docker: file.docker ?? null,
  };
}

/** The settings the web page may change in config.yml. */
export interface ConfigChanges {
  logLevel?: LogLevel;
  captureEveryMinutes?: number;
}

/**
 * Writes `changes` into config.yml, keeping its comments and layout, after
 * checking the whole result. The file is written in place, because in Docker
 * it is mounted as a single file and cannot be swapped for a new one; so the
 * old file is first copied to `backupPath`.
 */
export function updateConfigFile(path: string, changes: ConfigChanges, backupPath: string): void {
  readYaml(path); // a missing or broken file is reported the usual way
  const text = readFileSync(path, "utf8");
  const doc = parseDocument(text);
  if (changes.logLevel !== undefined) doc.setIn(["log_level"], changes.logLevel);
  if (changes.captureEveryMinutes !== undefined) doc.setIn(["capture", "every_minutes"], changes.captureEveryMinutes);
  const next = doc.toString();
  checkFile(parseYaml(next), path);
  if (next === text) return;
  copyFileSync(path, backupPath);
  writeFileSync(path, next);
}

/** `["mailboxes", 0, "username"]` -> `mailboxes[0].username` */
function formatPath(path: PropertyKey[]): string {
  if (path.length === 0) return "(whole file)";
  return path
    .map((part, i) => (typeof part === "number" ? `[${part}]` : `${i === 0 ? "" : "."}${String(part)}`))
    .join("");
}
