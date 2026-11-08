// Which bill each payment pays (the vault's "Hand-off" note, section 7).

import { describe, expect, it } from "vitest";
import {
  fitsFeeBand,
  headerOffset,
  namesBiller,
  pairPayments,
  senderDay,
  type FixedPairing,
  type PairingEmail,
  type PairingInput,
} from "../../../src/server/payments/pairing.js";

const WATER = 3;
/** When a fixed pairing was chosen, where it does not matter. */
const CHOSEN = "2026-11-01T12:00:00.000Z";
const POWER = 4;

/** A bill: dated `day` (noon UTC), `amount` dollars. */
function bill(id: string, day: string, amount: number | null, more: Partial<PairingEmail> = {}): PairingEmail {
  return {
    id,
    kind: "bill",
    billerId: WATER,
    billerName: "City Water",
    names: "",
    amountCents: amount === null ? null : Math.round(amount * 100),
    feeCents: null,
    invoiceNo: null,
    accountNo: null,
    notBill: false,
    emailTime: `${day}T12:00:00.000Z`,
    emailDay: day,
    paidDay: null,
    dueDay: null,
    ...more,
  };
}

/** A payment email dated `day`, paying `amount` dollars. */
function payment(id: string, day: string, amount: number, more: Partial<PairingEmail> = {}): PairingEmail {
  return { ...bill(id, day, amount), kind: "receipt", ...more };
}

/** Today, by default long after every email here, so nothing still waits for its bill email. */
const LATER = "2027-06-01";

function pair(emails: PairingEmail[], more: Partial<PairingInput> = {}) {
  return pairPayments({ emails, fixed: new Map(), reported: new Set(), startDate: null, today: LATER, ...more });
}

describe("pairPayments", () => {
  it("pairs a payment with the bill before it, on time", () => {
    const result = pair([bill("b1", "2026-10-06", 80, { dueDay: "2026-10-20" }), payment("p1", "2026-10-15", 80)]);
    expect(result.payments.get("p1")).toEqual({
      paymentId: "p1",
      billId: "b1",
      how: "auto",
      locked: false,
      needsBill: false,
      paidLate: false,
      feeCents: 0,
      baseCents: 8000,
      billMissing: false,
      beforeStart: false,
      staleChoice: false,
      waitingUntil: null,
      also: [],
      duplicateOf: null,
      maybeDuplicateOf: null,
    });
    expect(result.paidBy.get("b1")).toBe("p1");
  });

  it("pays the oldest unpaid bill and calls it late when another bill came between (the owner's case)", () => {
    const result = pair([bill("oct", "2026-10-06", 80), bill("nov", "2026-11-06", 80), payment("pay", "2026-11-10", 80)]);
    expect(result.payments.get("pay")).toMatchObject({ billId: "oct", paidLate: true, needsBill: false });
    expect(result.paidBy.has("nov")).toBe(false);
  });

  it("calls a payment after the bill's due date late", () => {
    const late = pair([bill("b", "2026-10-06", 80, { dueDay: "2026-10-20" }), payment("p", "2026-10-25", 80)]);
    expect(late.payments.get("p")!.paidLate).toBe(true);
    // The due date's own day is on time.
    const onDay = pair([bill("b", "2026-10-06", 80, { dueDay: "2026-10-20" }), payment("p", "2026-10-20", 80)]);
    expect(onDay.payments.get("p")!.paidLate).toBe(false);
  });

  it("uses the paid date as the payment's day when there is one", () => {
    // Emailed after the second bill, but paid before it: on time, the first bill.
    const result = pair([bill("oct", "2026-10-06", 80), bill("nov", "2026-11-06", 80), payment("pay", "2026-11-10", 80, { paidDay: "2026-10-30" })]);
    expect(result.payments.get("pay")).toMatchObject({ billId: "oct", paidLate: false });
  });

  it("gives each payment its own bill, in date order", () => {
    const result = pair([bill("oct", "2026-10-06", 80), bill("nov", "2026-11-06", 80), payment("p2", "2026-11-12", 80), payment("p1", "2026-10-12", 80)]);
    expect(result.payments.get("p1")!.billId).toBe("oct");
    expect(result.payments.get("p2")).toMatchObject({ billId: "nov", paidLate: false });
  });

  it("splits off the card fee within the fee band, and refuses one outside it", () => {
    const fee = pair([bill("b", "2026-10-06", 100), payment("p", "2026-10-10", 102.95)]);
    expect(fee.payments.get("p")).toMatchObject({ billId: "b", feeCents: 295, baseCents: 10000 });
    expect(pair([bill("b", "2026-10-06", 100), payment("p", "2026-10-10", 106.01)]).payments.get("p")!.needsBill).toBe(true);
  });

  it("never pairs a bill that asks for nothing, and a 0.00 bill does not make a payment late (MidAmerican, 2026-11-05)", () => {
    // Aug and Sep came out 0.00 after prepayments; the Oct 23 payment of 4.13 fit the
    // Aug 0.00 bill through the 6.00 band and was called late. It pays the Oct bill.
    const result = pair([
      bill("aug", "2026-08-14", 0, { dueDay: "2026-09-04" }),
      bill("sep", "2026-09-15", 0, { dueDay: "2026-10-06" }),
      bill("oct", "2026-10-14", 4.13, { dueDay: "2026-11-04" }),
      payment("p", "2026-10-24", 4.13, { paidDay: "2026-10-23" }),
    ]);
    expect(result.payments.get("p")).toMatchObject({ billId: "oct", feeCents: 0, paidLate: false });
    expect(result.paidBy.has("aug")).toBe(false);
    // With no other bill, a small payment waits for a person rather than paying a 0.00 bill.
    expect(pair([bill("aug", "2026-08-14", 0), payment("p", "2026-08-20", 5)]).payments.get("p")!.needsBill).toBe(true);
  });

  it("matches a payment that states its fee exactly, never through the fee band (Waste Management, 2026-11-05)", () => {
    // "Payment Amount $ 55.40, Convenience Fee $ 1.99, Total $ 57.39": pays the 55.40 bill, fee 1.99.
    const fee = pair([bill("jul", "2026-07-08", 55.4), payment("p", "2026-07-12", 57.39, { feeCents: 199 })]);
    expect(fee.payments.get("p")).toMatchObject({ billId: "jul", feeCents: 199, baseCents: 5540 });
    // A 60.00 payment stating a 0.00 fee is not the 56.52 bill plus 3.48: it was a prepayment.
    expect(pair([bill("aug", "2026-08-06", 56.52), payment("p", "2026-09-10", 60, { feeCents: 0 })]).payments.get("p")!.needsBill).toBe(true);
    // A stated fee that does not account for the difference does not fit either.
    expect(pair([bill("b", "2026-10-06", 100), payment("p", "2026-10-10", 102.95, { feeCents: 100 })]).payments.get("p")!.needsBill).toBe(true);
    // With no stated fee the band still applies.
    expect(pair([bill("aug", "2026-08-06", 56.52), payment("p", "2026-09-10", 60)]).payments.get("p")!.billId).toBe("aug");
  });

  it("pays the bill whose invoice number the payment names, before the oldest one (the city, 2026-11-05)", () => {
    // July's 52.76 is unpaid; October's is 52.76 too. The receipt names October's invoice.
    const emails = [
      bill("jul", "2026-07-16", 52.76, { invoiceNo: "14148653" }),
      bill("oct", "2026-10-19", 52.76, { invoiceNo: "14367795" }),
      payment("p", "2026-11-01", 52.76, { invoiceNo: "14367795" }),
    ];
    expect(pair(emails).payments.get("p")).toMatchObject({ billId: "oct", how: "auto" });
    // It still has to fit: a named invoice of another amount is not taken, and the oldest fitting bill is.
    const other = pair([bill("jul", "2026-07-16", 52.76), bill("oct", "2026-10-19", 60, { invoiceNo: "14367795" }), payment("p", "2026-11-01", 52.76, { invoiceNo: "14367795" })]);
    expect(other.payments.get("p")!.billId).toBe("jul");
    // A payment naming the invoice claims it before an earlier payment that names none takes it as the oldest.
    const claim = pair([
      bill("oct", "2026-10-19", 52.76, { invoiceNo: "14367795" }),
      payment("first", "2026-10-20", 52.76),
      payment("named", "2026-10-28", 52.76, { invoiceNo: "14367795" }),
    ]);
    expect(claim.payments.get("named")!.billId).toBe("oct");
    expect(claim.payments.get("first")!.needsBill).toBe(true);
  });

  it("never pairs a bill dated more than 14 days after the payment, another biller's bill, or one of a different amount", () => {
    expect(pair([bill("b", "2026-10-25", 80), payment("p", "2026-10-10", 80)]).payments.get("p")!.needsBill).toBe(true);
    expect(pair([bill("b", "2026-10-06", 80, { billerId: POWER }), payment("p", "2026-10-10", 80)]).payments.get("p")!.needsBill).toBe(true);
    expect(pair([bill("b", "2026-10-06", 80), payment("p", "2026-10-10", 79.99)]).payments.get("p")!.needsBill).toBe(true);
  });

  it("pays a bill whose email came in after the payment, up to 14 days later, on time (owner, 2026-11-05)", () => {
    // Waste Management: paid on the invoice date, the invoice email 5 days later.
    const early = pair([bill("sep", "2026-09-08", 56.94, { dueDay: "2026-10-03" }), payment("p", "2026-09-03", 56.94, { feeCents: 0 })]);
    expect(early.payments.get("p")).toMatchObject({ billId: "sep", how: "auto", paidLate: false, needsBill: false, waitingUntil: null });
    expect(pair([bill("b", "2026-10-24", 80), payment("p", "2026-10-10", 80)]).payments.get("p")!.billId).toBe("b");
    // The first fitting one after it, or the one naming its invoice number.
    const two = [bill("a", "2026-10-12", 80, { invoiceNo: "A" }), bill("b", "2026-10-14", 80, { invoiceNo: "B" })];
    expect(pair([...two, payment("p", "2026-10-10", 80)]).payments.get("p")!.billId).toBe("a");
    expect(pair([...two, payment("p", "2026-10-10", 80, { invoiceNo: "B" })]).payments.get("p")!.billId).toBe("b");
  });

  it("looks ahead only after every payment has had the bills before it", () => {
    // August's bill email is missing. The Aug 25 payment must not take September's bill,
    // which the Oct 1 payment pays (Midco's fixed amount, paid late).
    const result = pair([bill("sep", "2026-09-05", 114.93), payment("aug", "2026-08-25", 114.93), payment("sep-pay", "2026-10-01", 114.93)]);
    expect(result.payments.get("sep-pay")!.billId).toBe("sep");
    expect(result.payments.get("aug")).toMatchObject({ billId: null, needsBill: true });
    // A bill before the payment is still preferred to one after it.
    expect(pair([bill("old", "2026-10-01", 80), bill("new", "2026-10-12", 80), payment("p", "2026-10-10", 80)]).payments.get("p")!.billId).toBe("old");
  });

  it("waits for its bill email for 14 days, then needs a bill", () => {
    const emails = [payment("p", "2026-11-03", 60, { feeCents: 0 })];
    expect(pair(emails, { today: "2026-11-05" }).payments.get("p")).toMatchObject({ billId: null, how: null, needsBill: false, waitingUntil: "2026-11-17" });
    expect(pair(emails, { today: "2026-11-17" }).payments.get("p")!.waitingUntil).toBe("2026-11-17");
    expect(pair(emails, { today: "2026-11-18" }).payments.get("p")).toMatchObject({ needsBill: true, waitingUntil: null });
    // One with no biller can never find a bill by itself: it needs one at once.
    expect(pair([payment("p", "2026-11-03", 60, { billerId: null })], { today: "2026-11-05" }).payments.get("p")).toMatchObject({ needsBill: true, waitingUntil: null });
  });

  it("pays the oldest unpaid bills together when no one bill fits (Waste Management, 2026-11-05)", () => {
    // Aug 56.52 unpaid; Sep 56.94 invoiced Sep 3, emailed Sep 8; one payment of 113.46 on Sep 3 stating a 0.00 fee.
    const emails = [
      bill("aug", "2026-08-06", 56.52, { dueDay: "2026-09-04" }),
      bill("sep", "2026-09-08", 56.94, { dueDay: "2026-10-03" }),
      payment("p", "2026-09-03", 113.46, { feeCents: 0 }),
      payment("extra", "2026-09-09", 60, { feeCents: 0 }),
    ];
    const result = pair(emails);
    expect(result.payments.get("p")).toMatchObject({
      billId: "aug",
      how: "auto",
      feeCents: 0,
      baseCents: 5652,
      paidLate: false,
      also: [{ billId: "sep", cents: 5694, paidLate: false }],
    });
    expect(result.paidBy.get("aug")).toBe("p");
    expect(result.paidBy.get("sep")).toBe("p");
    // The 60.00 prepayment adds up to nothing.
    expect(result.payments.get("extra")!.needsBill).toBe(true);
  });

  it("tries only unpaid bills in a row, 2 or 3, and puts the fee on the oldest", () => {
    const three = [bill("a", "2026-07-06", 50), bill("b", "2026-08-06", 60), bill("c", "2026-09-06", 70)];
    expect(pair([...three, payment("p", "2026-09-10", 180)]).payments.get("p")).toMatchObject({ billId: "a", also: [{ billId: "b" }, { billId: "c" }] });
    // 50 + 70 also adds up to 120, but a and c are not in a row.
    expect(pair([...three, payment("p", "2026-09-10", 120)]).payments.get("p")!.needsBill).toBe(true);
    // Two in a row before the newest also count (a and b, 110), when the newest is not part of it.
    expect(pair([...three, payment("p", "2026-09-10", 110)]).payments.get("p")).toMatchObject({ billId: "a", also: [{ billId: "b" }] });
    // With no stated fee, the fee band applies to the sum, and the fee goes on the oldest bill.
    expect(pair([...three, payment("p", "2026-09-10", 112.5)]).payments.get("p")).toMatchObject({
      billId: "a",
      feeCents: 250,
      baseCents: 5000,
      also: [{ billId: "b", cents: 6000 }],
    });
    // Never four.
    expect(pair([...three, bill("d", "2026-09-07", 10), payment("p", "2026-09-10", 190)]).payments.get("p")!.needsBill).toBe(true);
  });

  it("pays the current bill with what was past due, not an older bill whose payment email is missing (owner, 2026-11-05)", () => {
    // The city: July's 52.76 has no payment email, so it looks unpaid. Oct and Nov are 52.76 too.
    // A payment of 105.52 on Nov 20 is Nov's invoice with Oct past due, not July and Oct.
    const city = [bill("jul", "2026-07-16", 52.76), bill("oct", "2026-10-19", 52.76, { invoiceNo: "O" }), bill("nov", "2026-11-16", 52.76, { invoiceNo: "N" })];
    expect(pair([...city, payment("p", "2026-11-20", 105.52)]).payments.get("p")).toMatchObject({ billId: "oct", also: [{ billId: "nov" }] });
    expect(pair([...city, payment("p", "2026-11-20", 105.52, { invoiceNo: "N" })]).payments.get("p")).toMatchObject({ billId: "oct", also: [{ billId: "nov" }] });
    // A payment naming Oct's invoice for 105.52 is Oct with July past due.
    expect(pair([...city, payment("p", "2026-11-20", 105.52, { invoiceNo: "O" })]).payments.get("p")).toMatchObject({ billId: "jul", also: [{ billId: "oct" }] });
  });

  it("gives what is left only to the bill right before, never past a paid one to an older bill (owner, 2026-11-05)", () => {
    // July looks unpaid, August was paid. 105.52 naming Oct's invoice is not Oct + July: the bill right
    // before Oct (August) is paid, so nothing was past due on it.
    const emails = [
      bill("jul", "2026-07-16", 52.76),
      bill("aug", "2026-08-14", 60),
      payment("aug-pay", "2026-08-29", 60),
      bill("oct", "2026-10-19", 52.76, { invoiceNo: "O" }),
    ];
    expect(pair([...emails, payment("p", "2026-11-01", 105.52, { invoiceNo: "O" })]).payments.get("p")).toMatchObject({ billId: null, needsBill: true });
    expect(pair([...emails, payment("p", "2026-11-01", 105.52)]).payments.get("p")).toMatchObject({ billId: null, needsBill: true });
    // A bill asking for nothing (a credit balance cleared it) stops the walk back too.
    const zero = [bill("jul", "2026-07-16", 52.76), bill("aug", "2026-08-14", 0), bill("oct", "2026-10-19", 52.76)];
    expect(pair([...zero, payment("p", "2026-11-01", 105.52)]).payments.get("p")!.needsBill).toBe(true);
  });

  it("lets a payment naming the current invoice take it with the bill past due before any other payment pairs", () => {
    // The Nov 20 payment names Nov's invoice and pays Oct + Nov. The Nov 22 payment (no invoice number)
    // fits Oct alone, but Oct is already paid by the one that named its current invoice.
    const emails = [
      bill("oct", "2026-10-19", 52.76, { invoiceNo: "O" }),
      bill("nov", "2026-11-16", 40, { invoiceNo: "N" }),
      payment("named", "2026-11-20", 92.76, { invoiceNo: "N" }),
      payment("plain", "2026-11-18", 52.76),
    ];
    const result = pair(emails);
    expect(result.payments.get("named")).toMatchObject({ billId: "oct", how: "auto", also: [{ billId: "nov", cents: 4000 }] });
    expect(result.payments.get("plain")!.needsBill).toBe(true);
    // Named bill plus the ones before it must still fit; otherwise the usual passes take over.
    expect(pair([bill("oct", "2026-10-19", 52.76), bill("nov", "2026-11-16", 40, { invoiceNo: "N" }), payment("p", "2026-11-20", 52.76, { invoiceNo: "N" })]).payments.get("p")!.billId).toBe("oct");
  });

  it("keeps an overpayment on the bill a person picked, never as a fee when the email states its fee (owner, 2026-11-05)", () => {
    // Waste Management's 60.00 stating "Convenience Fee $ 0.00", picked for the 56.52 bill: the 3.48 is a
    // credit the biller carries to its next bill, so it is not a fee and not the next bill's.
    const fixed = new Map<string, FixedPairing>([["p", { billId: "aug", alsoBillIds: [], locked: false, person: true, chosenAt: CHOSEN }]]);
    const emails = [bill("aug", "2026-08-06", 56.52), bill("sep", "2026-09-08", 56.94), payment("p", "2026-09-09", 60, { feeCents: 0 })];
    const result = pair(emails, { fixed });
    expect(result.payments.get("p")).toMatchObject({ billId: "aug", feeCents: 0, baseCents: 6000, also: [] });
    expect(result.paidBy.has("sep")).toBe(false);
    // A stated fee is that fee, the rest on the bill.
    const fee = pair([bill("aug", "2026-08-06", 55.4), payment("p", "2026-09-09", 60, { feeCents: 199 })], { fixed });
    expect(fee.payments.get("p")).toMatchObject({ feeCents: 199, baseCents: 5801 });
    // With no fee stated, what is over the bill is still taken as the fee, as before.
    expect(pair([bill("aug", "2026-08-06", 56.52), payment("p", "2026-09-09", 60)], { fixed }).payments.get("p")).toMatchObject({ feeCents: 348, baseCents: 5652 });
  });

  it("keeps a person's pick of several bills, sharing the payment out oldest first, and drops it when one cannot be paid", () => {
    const fixed = new Map<string, FixedPairing>([["p", { billId: "aug", alsoBillIds: ["sep"], locked: false, person: true, chosenAt: CHOSEN }]]);
    const emails = [bill("aug", "2026-08-06", 50), bill("sep", "2026-09-06", 60), payment("p", "2026-09-10", 100)];
    expect(pair(emails, { fixed }).payments.get("p")).toMatchObject({ billId: "aug", how: "person", feeCents: 0, baseCents: 5000, also: [{ billId: "sep", cents: 5000 }] });
    expect(pair(emails, { fixed, reported: new Set(["sep"]) }).payments.get("p")).toMatchObject({ billId: null, needsBill: true, staleChoice: true, also: [] });
  });

  it("keeps a locked payment for several bills as sent, and says when one of its bills is missing", () => {
    const locked = new Map<string, FixedPairing>([["p", { billId: "aug", alsoBillIds: ["sep"], locked: true, person: false, chosenAt: CHOSEN }]]);
    const emails = [bill("aug", "2026-08-06", 50), bill("sep", "2026-09-06", 60), payment("p", "2026-09-10", 110)];
    expect(pair(emails, { fixed: locked }).payments.get("p")).toMatchObject({ billId: "aug", locked: true, also: [{ billId: "sep", cents: 6000 }] });
    expect(pair(emails.filter((e) => e.id !== "sep"), { fixed: locked }).payments.get("p")).toMatchObject({ billId: "aug", billMissing: true, also: [] });
  });

  it("makes a part payment need a bill", () => {
    const result = pair([bill("b", "2026-10-06", 80), payment("p", "2026-10-10", 40)]);
    expect(result.payments.get("p")).toMatchObject({ billId: null, how: null, needsBill: true });
    expect(result.paidBy.size).toBe(0);
  });

  it("makes a payment with no biller need a bill", () => {
    expect(pair([bill("b", "2026-10-06", 80), payment("p", "2026-10-10", 80, { billerId: null })]).payments.get("p")!.needsBill).toBe(true);
  });

  it("lets a person's pick win, even a part payment, with no fee", () => {
    const fixed = new Map<string, FixedPairing>([["p", { billId: "nov", locked: false, person: true, chosenAt: CHOSEN, alsoBillIds: [] }]]);
    const result = pair([bill("oct", "2026-10-06", 80), bill("nov", "2026-11-06", 100), payment("p", "2026-11-10", 80)], { fixed });
    expect(result.payments.get("p")).toMatchObject({ billId: "nov", how: "person", feeCents: 0, baseCents: 8000, needsBill: false });
    expect(result.paidBy.get("nov")).toBe("p");
  });

  it("takes a person's pick before another payment can take that bill", () => {
    const fixed = new Map<string, FixedPairing>([["late", { billId: "oct", locked: false, person: true, chosenAt: CHOSEN, alsoBillIds: [] }]]);
    const result = pair([bill("oct", "2026-10-06", 80), payment("early", "2026-10-10", 80), payment("late", "2026-10-20", 80)], { fixed });
    expect(result.payments.get("late")!.billId).toBe("oct");
    expect(result.payments.get("early")!.needsBill).toBe(true);
  });

  it("keeps Paid on its own with no bill", () => {
    const fixed = new Map<string, FixedPairing>([["p", { billId: null, locked: false, person: true, chosenAt: CHOSEN, alsoBillIds: [] }]]);
    const result = pair([bill("b", "2026-10-06", 80), payment("p", "2026-10-10", 80)], { fixed });
    expect(result.payments.get("p")).toMatchObject({ billId: null, how: "own", needsBill: false });
    expect(result.paidBy.size).toBe(0);
  });

  it("keeps a locked pairing when a better bill turns up later", () => {
    // Locked with the November bill; an October bill captured later would now be the oldest fit.
    const fixed = new Map<string, FixedPairing>([["p", { billId: "nov", locked: true, person: false, chosenAt: CHOSEN, alsoBillIds: [] }]]);
    const result = pair([bill("oct", "2026-10-06", 80), bill("nov", "2026-11-06", 80), payment("p", "2026-11-10", 80)], { fixed });
    expect(result.payments.get("p")).toMatchObject({ billId: "nov", how: "auto", locked: true });
    expect(result.paidBy.has("oct")).toBe(false);
  });

  it("says when a fixed pairing's bill email is missing", () => {
    const fixed = new Map<string, FixedPairing>([["p", { billId: "gone", locked: true, person: false, chosenAt: CHOSEN, alsoBillIds: [] }]]);
    expect(pair([payment("p", "2026-10-10", 80)], { fixed }).payments.get("p")).toMatchObject({ billId: "gone", billMissing: true, locked: true, needsBill: false });
  });

  it("skips bills OurHome reported paid or removed", () => {
    const result = pair([bill("oct", "2026-10-06", 80), bill("nov", "2026-11-06", 80), payment("p", "2026-11-10", 80)], { reported: new Set(["oct"]) });
    expect(result.payments.get("p")).toMatchObject({ billId: "nov", paidLate: false });
    expect(pair([bill("b", "2026-10-06", 80), payment("p", "2026-10-10", 80)], { reported: new Set(["b"]) }).payments.get("p")!.needsBill).toBe(true);
  });

  it("leaves out emails marked Not a bill, on either side, and credits", () => {
    expect(pair([bill("b", "2026-10-06", 80, { notBill: true }), payment("p", "2026-10-10", 80)]).payments.get("p")!.needsBill).toBe(true);
    expect(pair([bill("b", "2026-10-06", 80), payment("p", "2026-10-10", 80, { notBill: true })]).payments.has("p")).toBe(false);
    expect(pair([bill("b", "2026-10-06", -80), payment("p", "2026-10-10", 0)]).payments.get("p")!.needsBill).toBe(true);
    expect(pair([payment("refund", "2026-10-10", -5)]).payments.has("refund")).toBe(false);
    // A bill marked Not a bill does not make a payment late either.
    const late = pair([bill("oct", "2026-10-06", 80), bill("promo", "2026-11-06", 80, { notBill: true }), payment("p", "2026-11-10", 80)]);
    expect(late.payments.get("p")!.paidLate).toBe(false);
  });

  it("is not a payment without a settled amount", () => {
    const noAmount: PairingEmail = { ...payment("p", "2026-10-10", 0), amountCents: null };
    expect(pair([bill("b", "2026-10-06", 80), noAmount]).payments.has("p")).toBe(false);
  });

  it("flags a bill dated before the OurHome start date", () => {
    const result = pair([bill("b", "2026-09-28", 80), payment("p", "2026-10-05", 80)], { startDate: "2026-10-01" });
    expect(result.payments.get("p")).toMatchObject({ billId: "b", beforeStart: true });
    expect(pair([bill("b", "2026-10-01", 80), payment("p", "2026-10-05", 80)], { startDate: "2026-10-01" }).payments.get("p")!.beforeStart).toBe(false);
  });
});

describe("fixed pairings, checked again on every read", () => {
  const pick = (billId: string): FixedPairing => ({ billId, locked: false, person: true, chosenAt: CHOSEN, alsoBillIds: [] });

  it("drops a person's pick whose bill can no longer be paid, without pairing it by itself", () => {
    for (const changed of [
      bill("b", "2026-10-06", 80, { notBill: true }),
      bill("b", "2026-10-06", null),
      bill("b", "2026-10-06", -80),
      { ...bill("b", "2026-10-06", 80), kind: "statement" as const },
    ]) {
      const result = pair([changed, bill("other", "2026-10-07", 80), payment("p", "2026-10-10", 80)], { fixed: new Map([["p", pick("b")]]) });
      expect(result.payments.get("p")).toMatchObject({ billId: null, how: null, needsBill: true, staleChoice: true });
    }
    const reported = pair([bill("b", "2026-10-06", 80), payment("p", "2026-10-10", 80)], { fixed: new Map([["p", pick("b")]]), reported: new Set(["b"]) });
    expect(reported.payments.get("p")).toMatchObject({ needsBill: true, staleChoice: true });
    const gone = pair([payment("p", "2026-10-10", 80)], { fixed: new Map([["p", pick("gone")]]) });
    expect(gone.payments.get("p")).toMatchObject({ needsBill: true, staleChoice: true, billMissing: false });
  });

  it("lets a locked pairing keep its bill over a person's pick of the same bill", () => {
    const fixed = new Map<string, FixedPairing>([
      ["p1", pick("b")],
      ["p2", { billId: "b", locked: true, person: false, chosenAt: CHOSEN, alsoBillIds: [] }],
    ]);
    const result = pair([bill("b", "2026-10-06", 80), payment("p1", "2026-10-08", 80), payment("p2", "2026-10-10", 80)], { fixed });
    expect(result.payments.get("p2")).toMatchObject({ billId: "b", locked: true });
    expect(result.payments.get("p1")).toMatchObject({ billId: null, needsBill: true, staleChoice: true });
    expect(result.paidBy.get("b")).toBe("p2");
  });

  it("gives a bill two people picked to the earlier pick, whatever order the payments are in", () => {
    const fixed = new Map<string, FixedPairing>([
      ["a-newer", { billId: "b", alsoBillIds: [], locked: false, person: true, chosenAt: "2026-11-02T09:00:00.000Z" }],
      ["z-older", { billId: "b", alsoBillIds: [], locked: false, person: true, chosenAt: "2026-11-01T09:00:00.000Z" }],
    ]);
    const result = pair([bill("b", "2026-10-06", 80), payment("a-newer", "2026-10-10", 80), payment("z-older", "2026-10-08", 80)], { fixed });
    expect(result.payments.get("z-older")).toMatchObject({ billId: "b", how: "person" });
    expect(result.payments.get("a-newer")).toMatchObject({ billId: null, needsBill: true, staleChoice: true });
  });

  describe("part payments: one bill, two payment emails (Xcel Energy, owner 2026-11-07)", () => {
    const at = (chosenAt: string, locked = false): FixedPairing => ({ billId: "b", alsoBillIds: [], locked, person: !locked, chosenAt });
    const emails = [bill("b", "2026-10-06", 140), payment("p90", "2026-10-15", 90), payment("p60", "2026-10-25", 60)];

    it("leaves the bill partly paid after the first pick, and the other payment free to pick it", () => {
      const result = pair(emails, { fixed: new Map([["p90", at("2026-11-07T09:00:00.000Z")]]) });
      expect(result.payments.get("p90")).toMatchObject({ billId: "b", how: "person", feeCents: 0, baseCents: 9000, needsBill: false });
      expect(result.leftCents.get("b")).toBe(5000);
      expect(result.payers.get("b")).toEqual(["p90"]);
      // The automatic pairing never adds a payment to it.
      expect(result.payments.get("p60")).toMatchObject({ billId: null, needsBill: true });
    });

    it("pays it in full with the second pick, the fee being what the second pays over the rest", () => {
      const fixed = new Map([
        ["p60", at("2026-11-07T10:00:00.000Z")],
        ["p90", at("2026-11-07T09:00:00.000Z")],
      ]);
      const result = pair(emails, { fixed });
      expect(result.payments.get("p90")).toMatchObject({ billId: "b", feeCents: 0, baseCents: 9000, staleChoice: false });
      expect(result.payments.get("p60")).toMatchObject({ billId: "b", feeCents: 1000, baseCents: 5000, staleChoice: false });
      expect(result.paidBy.get("b")).toBe("p90");
      expect(result.payers.get("b")).toEqual(["p90", "p60"]);
      expect(result.leftCents.get("b")).toBe(0);
      // Exactly what is owed: no fee.
      const exact = pair([bill("b", "2026-10-06", 150), payment("p90", "2026-10-15", 90), payment("p60", "2026-10-25", 60)], { fixed });
      expect(exact.payments.get("p60")).toMatchObject({ feeCents: 0, baseCents: 6000 });
      expect(exact.leftCents.get("b")).toBe(0);
    });

    it("refuses a third pick once the bill is paid in full", () => {
      const fixed = new Map([
        ["p90", at("2026-11-07T09:00:00.000Z")],
        ["p60", at("2026-11-07T10:00:00.000Z")],
        ["p20", at("2026-11-07T11:00:00.000Z")],
      ]);
      const result = pair([...emails, payment("p20", "2026-10-26", 20)], { fixed });
      expect(result.payments.get("p20")).toMatchObject({ billId: null, needsBill: true, staleChoice: true });
      expect(result.payers.get("b")).toEqual(["p90", "p60"]);
    });

    it("keeps each payment's part as it was when one of them was sent first", () => {
      const picks = new Map([
        ["p90", at("2026-11-07T09:00:00.000Z")],
        ["p60", at("2026-11-07T10:00:00.000Z")],
      ]);
      // The later pick sent first (the earlier one still waiting): locked, it keeps its pick time.
      const sentSecond = new Map([...picks, ["p60", at("2026-11-07T10:00:00.000Z", true)]]);
      for (const fixed of [picks, sentSecond]) {
        const result = pair(emails, { fixed });
        expect(result.payments.get("p90")).toMatchObject({ billId: "b", feeCents: 0, baseCents: 9000, staleChoice: false });
        expect(result.payments.get("p60")).toMatchObject({ billId: "b", feeCents: 1000, baseCents: 5000 });
      }
    });

    it("lets a pick pay the rest of a bill a locked payment paid only part of", () => {
      const fixed = new Map([
        ["p90", at("2026-11-07T09:00:00.000Z", true)],
        ["p60", at("2026-11-07T10:00:00.000Z")],
      ]);
      const result = pair(emails, { fixed });
      expect(result.payments.get("p90")).toMatchObject({ billId: "b", locked: true, baseCents: 9000 });
      expect(result.payments.get("p60")).toMatchObject({ billId: "b", how: "person", baseCents: 5000, feeCents: 1000 });
    });
  });

  it("keeps a locked pairing even when its bill could not be picked now", () => {
    const fixed = new Map<string, FixedPairing>([["p", { billId: "b", locked: true, person: false, chosenAt: CHOSEN, alsoBillIds: [] }]]);
    const result = pair([bill("b", "2026-10-06", 80, { notBill: true }), payment("p", "2026-10-10", 80)], { fixed, reported: new Set(["b"]) });
    expect(result.payments.get("p")).toMatchObject({ billId: "b", locked: true, needsBill: false, staleChoice: false });
  });
});

describe("second emails about one payment", () => {
  const WM = 5;
  const wm: Partial<PairingEmail> = { billerId: WM, billerName: "Waste Management" };
  /** PayPal's receipt: no biller, the merchant named in its subject, cut short as PayPal does. */
  const paypal = (id: string, day: string, amount: number, more: Partial<PairingEmail> = {}) =>
    payment(id, day, amount, { billerId: null, billerName: null, names: "waste management nat...: $57.39 usd paypal", ...more });
  const own: FixedPairing = { billId: null, locked: false, person: true, chosenAt: CHOSEN, alsoBillIds: [] };

  it("makes PayPal's receipt a duplicate of the biller's own confirmation, even when PayPal's came first (the owner's case)", () => {
    // PayPal's receipt at 8:02 pm Jul 11 in Sioux Falls; Waste Management's confirmation seven minutes later.
    const result = pair([
      bill("bill", "2026-07-01", 57.39, wm),
      paypal("pp", "2026-07-11", 57.39, { emailTime: "2026-07-12T03:02:43.000Z" }),
      payment("wm", "2026-07-11", 57.39, { ...wm, emailTime: "2026-07-12T03:09:27.000Z" }),
    ]);
    expect(result.payments.get("wm")).toMatchObject({ billId: "bill", how: "auto", duplicateOf: null });
    expect(result.payments.get("pp")).toMatchObject({ billId: null, how: null, needsBill: false, duplicateOf: "wm", maybeDuplicateOf: null });
    expect(result.paidBy.get("bill")).toBe("wm");
  });

  it("repeats a biller's payment that has no bill email either", () => {
    const result = pair([paypal("pp", "2026-07-11", 57.39), payment("wm", "2026-07-12", 57.39, wm)]);
    expect(result.payments.get("wm")).toMatchObject({ needsBill: true, duplicateOf: null });
    expect(result.payments.get("pp")).toMatchObject({ needsBill: false, duplicateOf: "wm" });
  });

  it("makes a biller's second confirmation of one payment a duplicate of the first, which keeps the bill", () => {
    const result = pair([bill("b", "2026-10-06", 80), payment("p1", "2026-10-15", 80), payment("p2", "2026-10-16", 80)]);
    expect(result.payments.get("p1")).toMatchObject({ billId: "b", duplicateOf: null });
    expect(result.payments.get("p2")).toMatchObject({ billId: null, needsBill: false, duplicateOf: "p1" });
  });

  it("keeps the older of two confirmations with no bill, whatever order they come in", () => {
    const result = pair([payment("newer", "2026-10-16", 80), payment("older", "2026-10-15", 80)]);
    expect(result.payments.get("older")).toMatchObject({ needsBill: true, duplicateOf: null });
    expect(result.payments.get("newer")).toMatchObject({ needsBill: false, duplicateOf: "older" });
  });

  it("leaves alone payments that each have a bill, however alike", () => {
    const result = pair([bill("oct", "2026-10-06", 80), bill("nov", "2026-11-06", 80), payment("p1", "2026-11-10", 80), payment("p2", "2026-11-12", 80)]);
    expect(result.payments.get("p1")).toMatchObject({ billId: "oct", duplicateOf: null });
    expect(result.payments.get("p2")).toMatchObject({ billId: "nov", duplicateOf: null });
  });

  it("needs the same amount in cents and payment days at most 3 apart", () => {
    const base = payment("wm", "2026-07-11", 57.39, wm);
    expect(pair([base, paypal("pp", "2026-07-11", 57.4)]).payments.get("pp")).toMatchObject({ needsBill: true, duplicateOf: null, maybeDuplicateOf: null });
    expect(pair([base, paypal("pp", "2026-07-14", 57.39)]).payments.get("pp")!.duplicateOf).toBe("wm");
    expect(pair([base, paypal("pp", "2026-07-08", 57.39)]).payments.get("pp")!.duplicateOf).toBe("wm");
    expect(pair([base, paypal("pp", "2026-07-15", 57.39)]).payments.get("pp")).toMatchObject({ needsBill: true, duplicateOf: null });
    // A paid date counts as the payment's day, as in pairing.
    expect(pair([base, paypal("pp", "2026-07-20", 57.39, { paidDay: "2026-07-12" })]).payments.get("pp")!.duplicateOf).toBe("wm");
  });

  it("never matches another biller's payment, and only names a maybe when the receipt does not name the biller", () => {
    expect(pair([payment("water", "2026-07-11", 57.39), payment("power", "2026-07-11", 57.39, { billerId: POWER })]).payments.get("power")).toMatchObject({
      needsBill: true,
      duplicateOf: null,
      maybeDuplicateOf: null,
    });
    // A debit card receipt names no merchant in its subject: only a maybe, for a person to settle.
    const debit = paypal("pp", "2026-07-11", 57.39, { names: "receipt for your paypal debit card purchase paypal" });
    expect(pair([payment("wm", "2026-07-11", 57.39, wm), debit]).payments.get("pp")).toMatchObject({ needsBill: true, duplicateOf: null, maybeDuplicateOf: "wm" });
  });

  it("never makes a payment with no biller an original", () => {
    const result = pair([paypal("a", "2026-07-11", 57.39), paypal("b", "2026-07-11", 57.39)]);
    for (const id of ["a", "b"]) expect(result.payments.get(id)).toMatchObject({ needsBill: true, duplicateOf: null, maybeDuplicateOf: null });
  });

  it("leaves a payment a person decided, or one already sent, as it is", () => {
    const wmPaid = payment("wm", "2026-07-11", 57.39, wm);
    expect(pair([wmPaid, paypal("pp", "2026-07-11", 57.39)], { fixed: new Map([["pp", own]]) }).payments.get("pp")).toMatchObject({ how: "own", duplicateOf: null });
    const stale: FixedPairing = { billId: "gone", locked: false, person: true, chosenAt: CHOSEN, alsoBillIds: [] };
    expect(pair([wmPaid, paypal("pp", "2026-07-11", 57.39)], { fixed: new Map([["pp", stale]]) }).payments.get("pp")).toMatchObject({
      needsBill: true,
      staleChoice: true,
      duplicateOf: null,
    });
    const sent: FixedPairing = { billId: null, locked: true, person: true, chosenAt: CHOSEN, alsoBillIds: [] };
    const locked = pair([bill("b", "2026-10-06", 80), payment("p1", "2026-10-15", 80), payment("p2", "2026-10-16", 80)], { fixed: new Map([["p2", sent]]) });
    expect(locked.payments.get("p2")).toMatchObject({ how: "own", locked: true, duplicateOf: null });
    expect(locked.payments.get("p1")).toMatchObject({ billId: "b", duplicateOf: null });
  });

  it("prefers the original that has its bill, then the nearest day", () => {
    // wm1 has the bill; wm2 (no bill) is a duplicate of it; PayPal's receipt is a duplicate of wm1, never of wm2.
    const result = pair([bill("b", "2026-07-01", 57.39, wm), payment("wm1", "2026-07-09", 57.39, wm), payment("wm2", "2026-07-11", 57.39, wm), paypal("pp", "2026-07-11", 57.39)]);
    expect(result.payments.get("wm2")!.duplicateOf).toBe("wm1");
    expect(result.payments.get("pp")!.duplicateOf).toBe("wm1");
  });
});

describe("namesBiller", () => {
  it("finds the biller's name, or its first 12 characters, at the start of a word", () => {
    expect(namesBiller("waste management nat...: $57.39 usd", "Waste Management")).toBe(true);
    expect(namesBiller("city of sioux...: $63.34 usd", "City of Sioux Falls Utility Billing")).toBe(true);
    expect(namesBiller("city of sio...: $63.34 usd", "City of Sioux Falls Utility Billing")).toBe(false);
    expect(namesBiller("you paid midco: $114.93 usd", "Midco")).toBe(true);
    expect(namesBiller("you paid amidco: $114.93 usd", "Midco")).toBe(false);
    expect(namesBiller("amidco and midco", "Midco")).toBe(true);
    expect(namesBiller("xcel energy: $3.00 usd", "  Xcel   Energy ")).toBe(true);
    expect(namesBiller("anything", null)).toBe(false);
    expect(namesBiller("anything", "   ")).toBe(false);
  });
});

describe("the sender's own day", () => {
  it("reads the offset of a Date header", () => {
    expect(headerOffset("Tue, 06 Oct 2026 20:30:00 -0500")).toBe(-300);
    expect(headerOffset("Tue, 06 Oct 2026 20:30:00 +0530 (IST)")).toBe(330);
    expect(headerOffset("Tue, 06 Oct 2026 20:30:00 CDT")).toBe(-300);
    expect(headerOffset("Tue, 06 Oct 2026 20:30:00 GMT")).toBe(0);
    expect(headerOffset("Tue, 06 Oct 2026 20:30:00")).toBeNull();
    expect(headerOffset(null)).toBeNull();
  });

  it("puts an evening email in Sioux Falls on that day, not the next UTC day", () => {
    expect(senderDay("2026-10-07T01:30:00.000Z", "Tue, 06 Oct 2026 20:30:00 -0500")).toBe("2026-10-06");
    expect(senderDay("2026-10-07T01:30:00.000Z", null)).toBe("2026-10-07");
  });

  it("uses that day for which bills a payment can pay, and for both late rules", () => {
    // A bill sent at 8:30 pm on Oct 6 (Oct 7 in UTC), paid on Oct 6.
    const evening = bill("b", "2026-10-07", 80, { emailTime: "2026-10-07T01:30:00.000Z", emailDay: "2026-10-06" });
    expect(pair([evening, payment("p", "2026-10-06", 80)]).payments.get("p")).toMatchObject({ billId: "b", needsBill: false });
    // A second bill sent the evening of the payment's day makes it late; one the next morning does not.
    const second = bill("b2", "2026-11-07", 80, { emailTime: "2026-11-07T01:30:00.000Z", emailDay: "2026-11-06" });
    expect(pair([bill("b1", "2026-10-06", 80), second, payment("p", "2026-11-06", 80)]).payments.get("p")).toMatchObject({ billId: "b1", paidLate: true });
    // A payment the evening of the due date is on time.
    const onDueDay = payment("p", "2026-10-21", 80, { emailTime: "2026-10-21T02:00:00.000Z", emailDay: "2026-10-20" });
    expect(pair([bill("b", "2026-10-06", 80, { dueDay: "2026-10-20" }), onDueDay]).payments.get("p")!.paidLate).toBe(false);
  });
});

describe("fitsFeeBand", () => {
  it("takes the bill up to the bill plus 6.00, or 4% when that is more, in cents", () => {
    // Small bills: the 6.00 floor.
    expect(fitsFeeBand(8000, 8000)).toBe(true);
    expect(fitsFeeBand(8600, 8000)).toBe(true);
    expect(fitsFeeBand(8601, 8000)).toBe(false);
    expect(fitsFeeBand(7999, 8000)).toBe(false);
    // 150.00: 4% is exactly 6.00.
    expect(fitsFeeBand(15600, 15000)).toBe(true);
    expect(fitsFeeBand(15601, 15000)).toBe(false);
    // 500.00: 4% is 20.00, more than the floor.
    expect(fitsFeeBand(52000, 50000)).toBe(true);
    expect(fitsFeeBand(52001, 50000)).toBe(false);
    // A typical card fee of 2.95% on 114.93.
    expect(fitsFeeBand(11832, 11493)).toBe(true);
  });
});
