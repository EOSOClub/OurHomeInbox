// City Water bill and payment emails for the pairing tests, as the reader
// picks them out: a bill with "Amount Due" (and a due date and an invoice
// number when given), a payment with "Amount Paid" and a "Payment Date".

/** "2026-10-06" as an email Date header, at noon UTC. */
function header(day: string): string {
  return new Date(`${day}T12:00:00Z`).toUTCString().replace("GMT", "+0000");
}

/** MM/DD/YYYY, as the emails print days. */
function printed(day: string): string {
  const [y, m, d] = day.split("-");
  return `${m}/${d}/${y}`;
}

function email(uid: number, subject: string, day: string, rows: Array<[string, string]>, from = "City Water <billing@water.example>", dateHeader?: string, note?: string): Buffer {
  const table = rows.map(([label, value]) => `<tr><td>${label}:</td><td>${value}</td></tr>`).join("");
  const lines = [
    `From: ${from}`,
    "To: sam@proton.me",
    `Subject: ${subject}`,
    `Date: ${dateHeader ?? header(day)}`,
    `Message-ID: <m${uid}@water.example>`,
    "Received: by mailin.protonmail.ch",
    `Authentication-Results: mail.protonmail.ch; dmarc=pass (p=reject dis=none) header.from=${from.includes("power") ? "power.example" : "water.example"}`,
    "Content-Type: text/html",
    "",
    `${note ? `<p>${note}</p>` : ""}<table>${table}</table>`,
    "",
  ];
  return Buffer.from(lines.join("\r\n"));
}

/** `dateHeader` replaces the Date header (noon UTC on `day`) with one as a sender writes it, "Tue, 06 Oct 2026 20:30:00 -0500". */
export function billEmail(
  uid: number,
  day: string,
  amount: string,
  options: { due?: string; invoice?: string; account?: string; power?: boolean; dateHeader?: string; pastDue?: boolean } = {},
): Buffer {
  const rows: Array<[string, string]> = [["Amount Due", `$${amount}`]];
  if (options.due) rows.push(["Due Date", printed(options.due)]);
  if (options.invoice) rows.push(["Invoice Number", options.invoice]);
  if (options.account) rows.push(["Account Number", options.account]);
  const note = options.pastDue ? "Your account is past due." : undefined;
  return email(uid, `Your bill ${uid} is ready`, day, rows, options.power ? "City Power <billing@power.example>" : undefined, options.dateHeader, note);
}

/** `paid: null` leaves the payment date out, so the payment's day is its email's day. */
export function paymentEmail(uid: number, day: string, amount: string, options: { paid?: string | null; dateHeader?: string } = {}): Buffer {
  const rows: Array<[string, string]> = [["Amount Paid", `$${amount}`]];
  if (options.paid !== null) rows.push(["Payment Date", printed(options.paid ?? day)]);
  return email(uid, `Payment received ${uid}`, day, rows, undefined, options.dateHeader);
}

/**
 * A payment service's receipt for a City Water payment, from a sender that is
 * not one of the household's billers: PayPal names the merchant in the
 * subject, cut short, "City Water Services...: $80.00 USD".
 */
export function serviceReceipt(uid: number, day: string, amount: string, subject = `City Water Services...: $${amount} USD`): Buffer {
  return email(uid, subject, day, [["Amount Paid", `$${amount}`], ["Payment Date", printed(day)]], "PayPal <service@paypal.example>");
}

/** The capture id of email `uid` in the test mailbox. */
export const id = (uid: number) => `proton-bills/1700000000/${uid}`;
