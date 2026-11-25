// The refund receipt a family gets — one per refund, so a second partial
// refund sends its own. Pure rendering up top (scripts/event-refund-tests.ts);
// the send at the bottom never throws, because the money has already moved.

import { escapeHtml } from "@/lib/eventInvoicing";

export type RefundReceipt = {
  clubName: string;
  clubContact: string | null;
  eventName: string;
  athleteName: string;
  /** This refund. */
  amount: number;
  paid: number;
  /** Everything refunded so far, this one included. */
  refundedTotal: number;
  /** The card, or how it was handed back. */
  via: "CARD" | "CASH" | "CHECK" | "OTHER";
  card: string | null;
  when: Date;
  timeZone: string | null;
  /** They were taken off the event at the same time. */
  removed: boolean;
};

const money = (n: number) => `$${n.toFixed(2)}`;

export function receiptDate(d: Date, tz: string | null): string {
  try {
    return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", ...(tz ? { timeZone: tz } : {}) });
  } catch {
    return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  }
}

export function refundReceiptSubject(r: RefundReceipt): string {
  return `Refund receipt: ${money(r.amount)} for ${r.eventName}`;
}

function wherePhrase(r: RefundReceipt): string {
  if (r.via === "CARD") return `${r.card ? `It's going back to your ${r.card}.` : "It's going back to the card you paid with."} It usually shows up in 5 to 10 business days.`;
  if (r.via === "CHECK") return "It's being returned by check.";
  if (r.via === "CASH") return "It's being returned in cash.";
  return "The club is returning it to you directly.";
}

function lines(r: RefundReceipt): [string, string][] {
  const keeps = Math.round((r.paid - r.refundedTotal) * 100) / 100;
  return [
    ["Event", r.eventName],
    ["Registered", r.athleteName],
    ["You paid", money(r.paid)],
    ["Refunded now", money(r.amount)],
    ...(r.refundedTotal > r.amount + 0.004 ? ([["Refunded in total", money(r.refundedTotal)]] as [string, string][]) : []),
    ...(keeps > 0.004 ? ([["Not refunded", money(keeps)]] as [string, string][]) : []),
    ["Date", receiptDate(r.when, r.timeZone)],
  ];
}

export function renderRefundReceiptHtml(r: RefundReceipt): string {
  const rows = lines(r)
    .map(([k, v]) => `<tr><td style="padding:6px 0;color:#57534e;font-size:14px">${escapeHtml(k)}</td><td style="padding:6px 0;text-align:right;color:#1c1917;font-size:14px">${escapeHtml(v)}</td></tr>`)
    .join("");
  return `
<div style="font-family:Inter,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#1c1917">
  <h2 style="margin:0 0 8px;font-size:22px">${money(r.amount)} refunded</h2>
  <p style="margin:0 0 16px;color:#57534e;line-height:1.6">${escapeHtml(wherePhrase(r))}</p>
  <table style="width:100%;border-collapse:collapse;border-top:1px solid #e7e5e4;border-bottom:1px solid #e7e5e4">${rows}</table>
  ${r.removed ? `<p style="margin:16px 0 0;color:#57534e;line-height:1.6">${escapeHtml(r.athleteName)} is no longer registered for ${escapeHtml(r.eventName)}.</p>` : ""}
  <p style="color:#57534e;font-size:13px;line-height:1.6;margin:16px 0 0">Questions? Contact ${escapeHtml(r.clubName)}${r.clubContact ? ` at ${escapeHtml(r.clubContact)}` : ""}.</p>
</div>`;
}

export function renderRefundReceiptText(r: RefundReceipt): string {
  return [
    `${money(r.amount)} refunded`,
    wherePhrase(r),
    "",
    ...lines(r).map(([k, v]) => `${k}: ${v}`),
    ...(r.removed ? ["", `${r.athleteName} is no longer registered for ${r.eventName}.`] : []),
    "",
    `Questions? Contact ${r.clubName}${r.clubContact ? ` at ${r.clubContact}` : ""}.`,
  ].join("\n");
}

/** Send it to the family: every guardian, plus the address on the registration. */
export async function sendRefundReceipt(args: {
  clubId: string;
  eventId: string;
  reg: { id: string; name: string | null; email: string | null; memberId: string | null };
  refundKey: string;
  actorUserId: string | null;
  receipt: RefundReceipt;
}): Promise<{ sent: number }> {
  let sent = 0;
  try {
    const [{ sendClubEmail }, { resolveRegistrationNotifyRecipients }] = await Promise.all([
      import("@/lib/sendClubEmail"),
      import("@/lib/eventRecipients"),
    ]);
    const recipients = await resolveRegistrationNotifyRecipients(args.clubId, args.reg as never);
    for (const to of recipients) {
      try {
        const res = await sendClubEmail({
          clubId: args.clubId,
          kind: "TRANSACTIONAL",
          recipientEmail: to.email,
          recipientUserId: to.userId,
          recipientMemberId: to.memberId,
          subject: refundReceiptSubject(args.receipt),
          bodyHtml: renderRefundReceiptHtml(args.receipt),
          bodyText: renderRefundReceiptText(args.receipt),
          fromName: args.receipt.clubName,
          sendBatchId: "event-refund",
          // Per refund AND per address: the ledger's unique key is
          // (batch, dedupeKey), so leaving the address out would drop the
          // second guardian's copy. The registration id stays second, which is
          // how the Attendees history finds it.
          dedupeKey: `event-refund:${args.reg.id}:${args.refundKey}:${to.email}`,
          relatedEventId: args.eventId,
          sentByUserId: args.actorUserId,
        });
        if (res.status === "SENT") sent++;
      } catch (e) {
        console.error("[event refund] receipt not sent", args.reg.id, e);
      }
    }
  } catch (e) {
    console.error("[event refund] receipt failed", args.reg.id, e);
  }
  return { sent };
}
