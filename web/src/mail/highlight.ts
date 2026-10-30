// Splits a body's text into plain and highlighted pieces. Nothing highlights
// yet; later, each value picked out of a bill (amount, due date, biller) will
// pass its character range here so the text views can show where it came from.

export interface TextHighlight {
  /** Start offset in the text, inclusive. */
  start: number;
  /** End offset in the text, exclusive. */
  end: number;
  /** What was found there, shown on hover. */
  label?: string;
}

export interface TextSegment {
  text: string;
  highlight: TextHighlight | null;
}

/** Ranges are clamped to the text; empty ranges and ones overlapping an earlier range are skipped. */
export function segmentText(text: string, highlights: readonly TextHighlight[] = []): TextSegment[] {
  const ranges = highlights
    .map((h) => ({ ...h, start: Math.max(0, Math.min(h.start, text.length)), end: Math.max(0, Math.min(h.end, text.length)) }))
    .filter((h) => h.end > h.start)
    .sort((a, b) => a.start - b.start);

  const segments: TextSegment[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor) continue;
    if (range.start > cursor) segments.push({ text: text.slice(cursor, range.start), highlight: null });
    segments.push({ text: text.slice(range.start, range.end), highlight: range });
    cursor = range.end;
  }
  if (cursor < text.length || segments.length === 0) segments.push({ text: text.slice(cursor), highlight: null });
  return segments;
}
