// Shows an email's HTML the only way this app ever renders it: inside an
// iframe with an empty sandbox (no scripts, forms, popups, navigation or
// same-origin access) and a document from prepareEmailHtml, whose
// Content-Security-Policy stops anything loading from the internet.
// The sandbox stops the page measuring the email's height, so the frame has
// a fixed height with its own scroll bar, and can be dragged taller.

import { useMemo } from "react";
import { Notice } from "../components/ui";
import { prepareEmailHtml } from "./safeEmail";

export function SafeEmailFrame({ html, title }: { html: string; title: string }) {
  const safe = useMemo(() => prepareEmailHtml(html), [html]);
  return (
    <div className="flex flex-col gap-3">
      {safe.remoteImages ? <Notice tone="info">Remote images are blocked to protect your privacy.</Notice> : null}
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
