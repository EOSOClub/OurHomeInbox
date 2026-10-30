// One-line, timestamped log output. Warnings and errors go to stderr.

import type { LogLevel } from "./config.js";

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold = RANK.info;

export function setLogLevel(level: LogLevel): void {
  threshold = RANK[level];
}

function write(level: LogLevel, message: string): void {
  if (RANK[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}`;
  if (RANK[level] >= RANK.warn) console.error(line);
  else console.log(line);
}

export const log = {
  debug: (message: string) => write("debug", message),
  info: (message: string) => write("info", message),
  warn: (message: string) => write("warn", message),
  error: (message: string) => write("error", message),
};
