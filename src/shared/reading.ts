// Turns an email body into the ordered pieces of text the reader looks at:
// one piece per table cell, paragraph, line or other block, with spaces
// tidied. Each piece remembers where every character came from, so a value
// found in a piece can be marked in the email itself.
//
// Shared by the server (which reads the HTML with parse5) and the web app
// (which reads it with the browser's DOMParser). Both follow the HTML
// standard, so they build the same tree and agree on the pieces; the web app
// still checks each piece's text before marking anything.

/** How to walk one parser's tree. `N` is that parser's node type. */
export interface ReadingTree<N> {
  /** A text node's text, or null for any other node. */
  text(node: N): string | null;
  /** An element's lower-case tag name, or null for any other node. */
  tag(node: N): string | null;
  children(node: N): Iterable<N>;
}

/** Where one run of a piece's characters came from: text node number `node`, from `start` up to `end`. */
export interface SourceRange {
  node: number;
  start: number;
  end: number;
}

export interface Reading {
  pieces: string[];
  /**
   * The source ranges behind characters `start` to `end` (exclusive) of
   * piece `piece`. For HTML, `node` counts text nodes in reading order; for
   * plain text it is always 0 and the offsets are into the text.
   */
  locate(piece: number, start: number, end: number): SourceRange[];
}

// Elements whose text is never read: code, styling, and what a page does not show.
const SKIPPED = new Set(["head", "script", "style", "template", "noscript", "title", "object", "iframe"]);

// Elements that start and end a piece.
const BLOCKS = new Set([
  "address", "article", "aside", "blockquote", "br", "caption", "center", "dd", "div", "dl", "dt", "fieldset",
  "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main",
  "nav", "ol", "p", "pre", "section", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
]);

// No-break and odd spaces read as a space; invisible characters (zero-width
// spaces and joiners, soft hyphens, the joiners some emails pad their
// preview text with) are dropped.
const SPACE = /[\s\p{Zs}]/u;
const INVISIBLE = /\p{Default_Ignorable_Code_Point}/u;

/** Builds pieces character by character, keeping each character's origin. */
class PieceBuilder {
  readonly pieces: string[] = [];
  private readonly origins: Array<Array<[number, number]>> = [];
  private chars: string[] = [];
  private from: Array<[number, number]> = [];
  private pendingSpace: [number, number] | null = null;

  add(text: string, node: number): void {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      if (INVISIBLE.test(ch)) continue;
      if (SPACE.test(ch)) {
        if (this.chars.length && !this.pendingSpace) this.pendingSpace = [node, i];
        continue;
      }
      if (this.pendingSpace) {
        this.chars.push(" ");
        this.from.push(this.pendingSpace);
        this.pendingSpace = null;
      }
      this.chars.push(ch);
      this.from.push([node, i]);
    }
  }

  /** Ends the current piece, if it has any text. */
  end(): void {
    if (this.chars.length) {
      this.pieces.push(this.chars.join(""));
      this.origins.push(this.from);
    }
    this.chars = [];
    this.from = [];
    this.pendingSpace = null;
  }

  reading(): Reading {
    this.end();
    const origins = this.origins;
    return {
      pieces: this.pieces,
      locate(piece, start, end) {
        const from = origins[piece] ?? [];
        const ranges: SourceRange[] = [];
        for (let i = Math.max(0, start); i < Math.min(end, from.length); i++) {
          const [node, offset] = from[i]!;
          const last = ranges[ranges.length - 1];
          // A tidied run of spaces stands for one character; the range still
          // covers everything up to the next kept character.
          if (last && last.node === node && offset >= last.end) last.end = offset + 1;
          else ranges.push({ node, start: offset, end: offset + 1 });
        }
        return ranges;
      },
    };
  }
}

/** Reads an HTML document (or any node in it). */
export function readTree<N>(root: N, tree: ReadingTree<N>): Reading & { textNodes: N[] } {
  const builder = new PieceBuilder();
  const textNodes: N[] = [];
  const walk = (node: N) => {
    const text = tree.text(node);
    if (text !== null) {
      builder.add(text, textNodes.length);
      textNodes.push(node);
      return;
    }
    const tag = tree.tag(node);
    if (tag !== null && SKIPPED.has(tag)) return;
    const block = tag !== null && BLOCKS.has(tag);
    if (block) builder.end();
    for (const child of tree.children(node)) walk(child);
    if (block) builder.end();
  };
  walk(root);
  return { ...builder.reading(), textNodes };
}

/** Reads a plain text body: one piece per line. */
export function readText(text: string): Reading {
  const builder = new PieceBuilder();
  let lineStart = 0;
  for (const line of text.split(/\r\n|\r|\n/)) {
    // add() is given the line, so offsets are shifted to the whole text below.
    builder.add(line, lineStart);
    builder.end();
    lineStart += line.length + (text.startsWith("\r\n", lineStart + line.length) ? 2 : 1);
  }
  const reading = builder.reading();
  return {
    pieces: reading.pieces,
    // Here `node` held the line's start offset; turn it into offsets in the text.
    locate: (piece, start, end) =>
      reading.locate(piece, start, end).map((r) => ({ node: 0, start: r.node + r.start, end: r.node + r.end })),
  };
}
