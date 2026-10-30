import { describe, expect, it } from "vitest";
import { readHtml } from "../src/server/extraction.js";
import { readText } from "../src/shared/reading.js";

describe("readHtml", () => {
  it("gives one piece per block, with spaces tidied", () => {
    const html = `<html><head><title>Bill</title><style>td{color:red}</style></head><body>
      <p>YOUR   BILL IS
         READY</p>
      <table><tr><td>Amount&nbsp;Billed:</td><td> $4.13 </td></tr></table>
      Line one<br>Line two
    </body></html>`;
    expect(readHtml(html).pieces).toEqual(["YOUR BILL IS READY", "Amount Billed:", "$4.13", "Line one", "Line two"]);
  });

  it("keeps inline elements in one piece and drops invisible characters", () => {
    const html = "<div>Amount Due: <b>$</b><span>114</span>.93</div><div>pre​view­text͏</div>";
    expect(readHtml(html).pieces).toEqual(["Amount Due: $114.93", "previewtext"]);
  });

  it("never reads scripts, styles, templates or comments", () => {
    const html = "<div>Due Date: 11/04/2026</div><script>var a='Amount Due: $1.00'</script><!-- Amount: $2.00 --><template>Total $3.00</template><noscript>Total $4.00</noscript>";
    expect(readHtml(html).pieces).toEqual(["Due Date: 11/04/2026"]);
  });

  it("finds where each character came from", () => {
    const html = "<td>Amount   Due: <b>$114.93</b></td>";
    const reading = readHtml(html);
    expect(reading.pieces).toEqual(["Amount Due: $114.93"]);
    // "Due: $114.93" spans the first text node (with its run of spaces) and the bold one.
    expect(reading.locate(0, 7, 19)).toEqual([
      { node: 0, start: 9, end: 14 },
      { node: 1, start: 0, end: 7 },
    ]);
    expect(reading.locate(0, 0, 10)).toEqual([{ node: 0, start: 0, end: 12 }]);
  });
});

describe("readText", () => {
  it("gives one piece per non-empty line, and offsets into the whole text", () => {
    const text = "Hello\r\n\r\n  Amount  Due:   $5.00 \nDue Date: 11/04/2026";
    const reading = readText(text);
    expect(reading.pieces).toEqual(["Hello", "Amount Due: $5.00", "Due Date: 11/04/2026"]);
    const [range] = reading.locate(1, 12, 17);
    expect(text.slice(range!.start, range!.end)).toBe("$5.00");
    const [date] = reading.locate(2, 10, 20);
    expect(text.slice(date!.start, date!.end)).toBe("11/04/2026");
    // A tidied run of spaces is covered in full.
    const [label] = reading.locate(1, 0, 11);
    expect(text.slice(label!.start, label!.end)).toBe("Amount  Due:");
  });
});
