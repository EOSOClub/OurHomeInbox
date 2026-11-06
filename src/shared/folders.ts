// The folder path a mailbox reads, from what a person typed. Shared by the
// server (which saves it) and the web app (which shows it as it is added),
// so both always agree.
//
// Proton Mail Bridge puts a person's own folders under "Folders/" and their
// labels under "Labels/", next to Proton's own folders (INBOX, Archive...).
// People know their folder as "Finance/Bills", the way Proton shows it, so
// "Folders/" is added for them (owner, 2026-11-04). A name that already starts
// with "Folders/" or "Labels/", or is one of Proton's own, is kept. Done when a
// folder is added, not when mail is read, so "Finance/Bills" and
// "Folders/Finance/Bills" are one folder with one place for its mail.

import type { Provider } from "./settings.js";

/** The folders Proton Mail Bridge shows at the top level, beside "Folders/" and "Labels/". */
export const PROTON_TOP_FOLDERS = ["INBOX", "Drafts", "Sent", "Starred", "Archive", "Spam", "Trash", "All Mail", "Scheduled", "Folders", "Labels"] as const;

/** The path to read for a typed folder: trimmed, and for Proton Mail Bridge with "Folders/" added when it needs it. */
export function folderPath(provider: Provider, typed: string): string {
  const folder = typed.trim();
  if (provider !== "proton-bridge") return folder;
  // Slashes at either end mean nothing in a Proton path.
  const path = folder.replace(/^[\s/]+|[\s/]+$/g, "");
  if (path === "") return "";
  const top = PROTON_TOP_FOLDERS.find((name) => name.toLowerCase() === path.toLowerCase());
  if (top) return top;
  // "folders/x" and "labels/x" in any capitals are written the way the Bridge does.
  const [first, ...rest] = path.split("/");
  const root = first!.toLowerCase();
  if (rest.length > 0 && (root === "folders" || root === "labels")) return `${root === "folders" ? "Folders" : "Labels"}/${rest.join("/")}`;
  return `Folders/${path}`;
}
