// Shows an email's HTML the only way this app ever renders it: inside an
// iframe with an empty sandbox (no scripts, forms, popups, navigation or
// same-origin access) and a document from prepareEmailHtml, whose
// Content-Security-Policy stops anything loading from the internet.
// The sandbox stops the page measuring the email's height, so the frame has
// a fixed height with its own scroll bar, and can be dragged taller.
// With `marks`, the values the reader picked out are marked in the email.

import { useMemo } from "react";
import { Notice } from "../components/ui";
import { prepareEmailHtml, type EmailMarks } from "./safeEmail";

export function SafeEmailFrame({ html, title, marks }: { html: string; title: string; marks?: EmailMarks }) {
  const safe = useMemo(() => prepareEmailHtml(html, marks), [html, marks]);
  return (
    <div className="flex flex-col gap-3">
      {safe.remoteImages ? <Notice tone="info">Remote images are blocked to protect your privacy.</Notice> : null}
      {safe.unmarked > 0 ? (
        <Notice tone="info">
          Some picked-out values could not be marked in this view. They are listed under Picked out above.
        </Notice>
      ) : null}
      <div className="h-[70vh] min-h-80 resize-y overflow-hidden rounded-md border border-line bg-white">
        <iframe
          sandbox=""
          srcDoc={safe.document}
          referrerPolicy="no-referrer"
          title={title}
          className="block h-full w-full border-0"
        />
      </div>
    </div>
  );
}
