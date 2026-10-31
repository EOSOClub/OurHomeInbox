// Reads the text of a PDF invoice into pieces the reader understands, using
// pdf.js (Mozilla's PDF reader). A PDF came from a stranger's link, so only
// its text is read: no XFA forms, no fonts loaded into anything, nothing
// drawn. pdf.js 6 never runs a PDF's scripts and has no code path that turns
// a PDF's contents into code (the old isEvalSupported option is gone with it).
//
// Invoices are laid out on a page, not written as text in order: a label can
// sit left of its value or above it. So the words are grouped into lines by
// their height on the page, each line is cut into cells where there is a gap,
// and each piece remembers the piece just below it.

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { InvoiceText, PiecePlace } from "../shared/extraction.js";

/** More pages than this are not read (an invoice has a few). */
export const MAX_PDF_PAGES = 30;

interface Word {
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
}

interface Cell {
  x0: number;
  x1: number;
  y: number;
  height: number;
  text: string;
  place: PiecePlace;
}

/** Spaces tidied and invisible characters dropped, as in the email's own pieces. */
function tidy(text: string): string {
  return text
    .replace(/\p{Default_Ignorable_Code_Point}/gu, "")
    .replace(/[\s\p{Zs}]+/gu, " ")
    .trim();
}

/** One page's words as cells, top line first, left to right. */
function cellsOf(words: Word[], page: number): Cell[] {
  const sorted = [...words].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: Word[][] = [];
  for (const word of sorted) {
    const line = lines.at(-1);
    // Same line when the baselines are close for the text's size.
    if (line && Math.abs(line[0]!.y - word.y) <= Math.max(2, 0.3 * Math.max(word.height, line[0]!.height))) line.push(word);
    else lines.push([word]);
  }
  const cells: Cell[] = [];
  lines.forEach((line, lineIndex) => {
    line.sort((a, b) => a.x - b.x);
    let cell: Cell | null = null;
    for (const word of line) {
      const size = Math.max(word.height, cell?.height ?? 0);
      const gap = cell ? word.x - cell.x1 : Infinity;
      // A gap wider than a few spaces starts a new cell: "Total Due by" | "11/04/2026".
      if (cell && gap <= 0.6 * size) {
        cell.text += gap > 0.15 * size && !cell.text.endsWith(" ") ? ` ${word.text}` : word.text;
        cell.x1 = Math.max(cell.x1, word.x + word.width);
        cell.height = size;
      } else {
        cell = { x0: word.x, x1: word.x + word.width, y: word.y, height: word.height, text: word.text, place: { page, line: lineIndex } };
        cells.push(cell);
      }
    }
  });
  return cells.map((c) => ({ ...c, text: tidy(c.text) })).filter((c) => c.text !== "");
}

/** For each cell, the nearest cell on a lower line of the same page that overlaps it sideways, or null. */
function belowOf(cells: readonly Cell[], offset: number): Array<number | null> {
  return cells.map((cell) => {
    let best: number | null = null;
    let bestDistance = Infinity;
    for (const [index, other] of cells.entries()) {
      if (other.place.line <= cell.place.line) continue;
      const distance = cell.y - other.y;
      if (distance <= 0 || distance > 3.5 * Math.max(cell.height, other.height)) continue;
      const overlap = Math.min(cell.x1, other.x1) - Math.max(cell.x0, other.x0);
      if (overlap > 0 && distance < bestDistance) {
        best = index + offset;
        bestDistance = distance;
      }
    }
    return best;
  });
}

/** The text of a PDF as pieces, or null when it has no text (a scan) or cannot be read. */
export async function readPdf(data: Uint8Array): Promise<{ text: InvoiceText; pages: number } | null> {
  const loading = getDocument({
    // pdf.js takes the buffer over; give it a copy.
    data: new Uint8Array(data),
    enableXfa: false,
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    verbosity: 0,
  });
  let doc;
  try {
    doc = await loading.promise;
  } catch {
    await loading.destroy();
    return null;
  }
  try {
    const text: InvoiceText = { pieces: [], places: [], below: [] };
    const pages = Math.min(doc.numPages, MAX_PDF_PAGES);
    for (let number = 1; number <= pages; number++) {
      const page = await doc.getPage(number);
      const content = await page.getTextContent();
      const words: Word[] = [];
      for (const item of content.items) {
        if (!("str" in item) || item.str.trim() === "") continue;
        const [, , , , x, y] = item.transform as number[];
        words.push({ x: x!, y: y!, width: item.width, height: item.height, text: item.str });
      }
      const cells = cellsOf(words, number);
      text.below.push(...belowOf(cells, text.pieces.length));
      for (const cell of cells) {
        text.pieces.push(cell.text);
        text.places.push(cell.place);
      }
    }
    return text.pieces.length ? { text, pages: doc.numPages } : null;
  } catch {
    return null;
  } finally {
    await loading.destroy();
  }
}
