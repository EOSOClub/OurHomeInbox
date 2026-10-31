// The email's own words around a picked value, with the label and the value
// marked: shown under each value in Picked out and each choice in Fix.

import type { PickSpot } from "../../../src/shared/extraction";
import { segmentText, type TextHighlight } from "./highlight";
import { around } from "./picked";
import { highlightClasses } from "./TextBlock";

/** A piece of the email with some ranges marked, shortened around the first mark. */
function Snippet({ piece, highlights }: { piece: string; highlights: TextHighlight[] }) {
  const first = Math.min(...highlights.map((h) => h.start));
  const last = Math.max(...highlights.map((h) => h.end));
  const { text, offset } = around(piece, first, last);
  const shifted = highlights.map((h) => ({ ...h, start: h.start - offset, end: h.end - offset }));
  return (
    <>
      {segmentText(text, shifted).map((segment, index) =>
        segment.highlight ? (
          <mark key={index} className={highlightClasses(segment.highlight.tone)}>
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

/** Some words in one piece, marked, in the email's (or its invoice's) words. */
export function Said({ piece, start, end, inInvoice = false }: { piece: string; start: number; end: number; inInvoice?: boolean }) {
  return (
    <span className="mt-1 block rounded-md border border-line bg-surface-muted px-2 py-1 font-mono text-xs leading-relaxed wrap-anywhere">
      <span className="sr-only">{inInvoice ? "In the invoice: " : "In the email: "}</span>
      <Snippet piece={piece} highlights={[{ start, end, tone: "value" }]} />
    </span>
  );
}

/** Where a value was found: its label and the value, in the email's (or its invoice's) words. */
export function Where({ pieces, spot, inInvoice = false }: { pieces: readonly string[]; spot: PickSpot; inInvoice?: boolean }) {
  const label: TextHighlight = { ...spot.label, tone: "label" };
  const value: TextHighlight = { ...spot.value, tone: "value" };
  const labelPiece = pieces[spot.labelPiece] ?? "";
  const valuePiece = pieces[spot.valuePiece] ?? "";
  return (
    <span className="mt-1 block rounded-md border border-line bg-surface-muted px-2 py-1 font-mono text-xs leading-relaxed wrap-anywhere">
      <span className="sr-only">{inInvoice ? "In the invoice: " : "In the email: "}</span>
      {spot.labelPiece === spot.valuePiece ? (
        <Snippet piece={labelPiece} highlights={[label, value]} />
      ) : (
        <>
          <Snippet piece={labelPiece} highlights={[label]} />
          <span aria-hidden className="px-1.5 text-muted">
            |
          </span>
          <Snippet piece={valuePiece} highlights={[value]} />
        </>
      )}
    </span>
  );
}
