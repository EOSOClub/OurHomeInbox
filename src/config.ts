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
 * Connection values each provider fills in when config.yml leaves them out.
 * Proton Bridge: the name and port it has on the Docker network (see the
 * proton-bridge stack in OurHomeServices). Its certificate is issued for
 * 127.0.0.1 only, so TLS to that name always fails; the traffic stays inside
 * Docker, and the Bridge talks to Proton end-to-end encrypted.
 */
const PROVIDER_DEFAULTS: Record<Provider, { host: string; port: number; tls: boolean }> = {
  "proton-bridge": { host: "protonmail-bridge", port: 143, tls: false },
};

// .strict() turns a misspelt setting into an error instead of silently ignoring it.
const mailboxSchema = z
  .object({
    name: z.string().trim().min(1),
    provider: z.enum(PROVIDERS),
    host: z.string().trim().min(1).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    tls: z.boolean().optional(),
    username: z.string().trim().min(1),
    password_env: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/, "must be an .env name in capitals, like PROTON_BRIDGE_PASSWORD"),
    folder: z.string().trim().min(1).default("INBOX"),
  })
  .strict();

const fileSchema = z
  .object({
    log_level: z.enum(LOG_LEVELS).default("info"),
    mailboxes: z
      .array(mailboxSchema)
      .min(1, "add at least one mailbox")
      .refine((list) => new Set(list.map((m) => m.name)).size === list.length, "each mailbox needs its own name"),
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

export interface MailboxConfig {
  name: string;
  provider: Provider;
  host: string;
  port: number;
  tls: boolean;
  username: string;
  password: string;
  folder: string;
}

export interface Config {
  logLevel: LogLevel;
  mailboxes: MailboxConfig[];
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

/** Reads config.yml, checks it, and fills in each mailbox's password from the environment. */
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
    const defaults = PROVIDER_DEFAULTS[mailbox.provider];
    const password = env[mailbox.password_env] ?? "";
    if (password === "") {
      problems.push(`${mailbox.password_env} is empty or missing in .env (the password for mailbox "${mailbox.name}").`);
    }
    return {
      name: mailbox.name,
      provider: mailbox.provider,
      host: mailbox.host ?? defaults.host,
      port: mailbox.port ?? defaults.port,
      tls: mailbox.tls ?? defaults.tls,
      username: mailbox.username,
      password,
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
