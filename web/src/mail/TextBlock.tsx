// Shows a body as plain text with its line breaks kept: the plain text part,
// or the HTML source (as text, never rendered). Takes optional highlight
// ranges to mark where each picked-out value and its label came from.

import { segmentText, type TextHighlight } from "./highlight";

/** The look of a highlight, shared with the other places picks are shown. */
export function highlightClasses(tone: TextHighlight["tone"]): string {
  // A label is underlined rather than tinted: a light tint disappears on the grey text background.
  return tone === "label"
    ? "bg-transparent text-ink underline decoration-accent decoration-2 underline-offset-2"
    : "rounded-sm bg-warn-soft text-ink ring-1 ring-warn-line";
}

export function TextBlock({ text, highlights, label }: { text: string; highlights?: readonly TextHighlight[]; label: string }) {
  const segments = segmentText(text, highlights);
  return (
    <pre
      aria-label={label}
      className="max-h-[70vh] overflow-auto whitespace-pre-wrap wrap-anywhere rounded-md border border-line bg-surface-muted p-3 font-mono text-sm leading-relaxed"
    >
      {segments.map((segment, index) =>
        segment.highlight ? (
          <mark key={index} title={segment.highlight.label} className={highlightClasses(segment.highlight.tone)}>
            {segment.text}
          </mark>
        ) : (
          segment.text
        ),
      )}
    </pre>
  );
}
