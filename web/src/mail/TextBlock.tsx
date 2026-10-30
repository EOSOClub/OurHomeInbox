// Shows a body as plain text with its line breaks kept: the plain text part,
// or the HTML source (as text, never rendered). Takes optional highlight
// ranges so a later version can mark where each picked-out value came from.

import { segmentText, type TextHighlight } from "./highlight";

export function TextBlock({ text, highlights, label }: { text: string; highlights?: readonly TextHighlight[]; label: string }) {
  const segments = segmentText(text, highlights);
  return (
    <pre
      aria-label={label}
      className="max-h-[70vh] overflow-auto whitespace-pre-wrap wrap-anywhere rounded-md border border-line bg-surface-muted p-3 font-mono text-sm leading-relaxed"
    >
      {segments.map((segment, index) =>
        segment.highlight ? (
          <mark key={index} title={segment.highlight.label} className="rounded-sm bg-warn-soft text-ink ring-1 ring-warn-line">
            {segment.text}
          </mark>
        ) : (
          segment.text
        ),
      )}
    </pre>
  );
}
