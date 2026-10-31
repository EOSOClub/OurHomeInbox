// One-line, timestamped log output. Warnings and errors go to stderr, and the
// most recent ones are also kept in memory (whatever the log level) for the
// Status page; a restart forgets them.

import type { LogLevel } from "./config.js";

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold = RANK.info;

export function setLogLevel(level: LogLevel): void {
  threshold = RANK[level];
}

/** A warning or error, as kept for the Status page. */
export interface LogProblem {
  at: string;
  level: "warn" | "error";
  message: string;
}

/** How many recent warnings and errors are kept. */
export const KEPT_PROBLEMS = 100;
const problems: LogProblem[] = [];

/** The kept warnings and errors, newest first. */
export function recentProblems(): LogProblem[] {
  return [...problems].reverse();
}

function write(level: LogLevel, message: string): void {
  const at = new Date().toISOString();
  if (level === "warn" || level === "error") {
    problems.push({ at, level, message });
    if (problems.length > KEPT_PROBLEMS) problems.shift();
  }
  if (RANK[level] < threshold) return;
  const line = `${at} ${level.toUpperCase().padEnd(5)} ${message}`;
  if (RANK[level] >= RANK.warn) console.error(line);
  else console.log(line);
}

export const log = {
  debug: (message: string) => write("debug", message),
  info: (message: string) => write("info", message),
  warn: (message: string) => write("warn", message),
  error: (message: string) => write("error", message),
};
