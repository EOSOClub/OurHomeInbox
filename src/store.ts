// Captured mail on disk, one folder per message:
//   <root>/<mailbox>/<uidvalidity>/<uid>/message.eml        the raw email, as received
//   <root>/<mailbox>/<uidvalidity>/<uid>/attachments/<n>-<name>
//   <root>/<mailbox>/<uidvalidity>/<uid>/capture.json       what was captured, written last
//
// A message counts as captured only once capture.json exists, so a run that
// stops part way captures that message again next time. UIDVALIDITY is part of
// the path because a server that resets it reuses uids for different mail.
// A captured message is never changed or deleted here.

import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CaptureResult } from "./capture.js";
import { mailboxSlug } from "./config.js";

export class CaptureStore {
  constructor(readonly root: string) {}

  messageDir(mailbox: string, uidValidity: string, uid: number): string {
    if (!/^\d+$/.test(uidValidity)) throw new Error(`Unexpected UIDVALIDITY ${JSON.stringify(uidValidity)}`);
    if (!Number.isSafeInteger(uid) || uid < 1) throw new Error(`Unexpected uid ${uid}`);
    return join(this.root, mailboxSlug(mailbox), uidValidity, String(uid));
  }

  has(mailbox: string, uidValidity: string, uid: number): boolean {
    return existsSync(join(this.messageDir(mailbox, uidValidity, uid), "capture.json"));
  }

  /** Saves one message and returns its folder. */
  async save(result: CaptureResult, raw: Buffer): Promise<string> {
    const { capture } = result;
    const dir = this.messageDir(capture.mailbox, capture.uidValidity, capture.uid);
    if (existsSync(join(dir, "capture.json"))) throw new Error(`Message ${capture.uid} is already captured`);

    // Anything here is left over from a run that stopped part way.
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, capture.raw.file), raw);
    for (const attachment of result.attachments) {
      const path = join(dir, attachment.file);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, attachment.content);
    }
    // Last, and in one step, so it only ever exists complete.
    const json = join(dir, "capture.json");
    await writeFile(`${json}.tmp`, `${JSON.stringify(capture, null, 2)}\n`);
    await rename(`${json}.tmp`, json);
    return dir;
  }
}
