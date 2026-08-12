import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { computeProcessingFeeCents } from "@/lib/fees";
import { billOneRegistrant, escapeHtml } from "@/lib/eventInvoicing";
import { getAppBaseUrl } from "@/lib/baseUrl";

import {
  amountToCollect,
  expectedAmount,
  collectionBreakdown,
  registrationListPrice,
} from "@/lib/eventRepricing";
import { requirePermission } from "@/lib/apiGuard";
import { resolveRegistrationRecipients } from "@/lib/eventRecipients";

const bodySchema = z.object({
  // Re-invoice registrants who were already invoiced (still skips PAID).
  force: z.boolean().optional().default(false),
  // Invoice only these registrations. When omitted, invoice every active,
  // unpaid registrant who hasn't been invoiced yet (or all of them if force).
  registrationIds: z.array(z.string()).optional(),
  // Dry run: return exactly what each registrant would be emailed and charged,
  // without creating a single Stripe session or sending a single email. This
  // is what the "Review before sending" screen calls.
  preview: z.boolean().optional().default(false),
  // Acknowledge that some registrants will be billed an amount that differs
  // from the event's current price (a per-registrant override, or a stale
  // snapshot). Without it, a mismatch is a hard 409 instead of an email.
  confirmMismatched: z.boolean().optional().default(false),
});

// POST /api/events/[id]/bill-registrants
// Mass-invoice event registrants.
//
// Variable-cost events (both modes):
//   OFFICIAL  — split variableCostTotal across actual active registrants
//               (the "bill after the event" flow).
//   ESTIMATED — split the estimated shared total by expected signups
//               (the "bill before the event when you choose" flow).
//
// Fixed-price events: a public registrant is recorded BEFORE Stripe Checkout,
// so an abandoned checkout leaves a REGISTERED row owing the price with no
// way to pay. This route emails each unpaid registrant a fresh payment link
// for their recorded amountDue (falling back to the event's public price).
//
// Owner/staff trigger this whenever they're ready; payment never has to
// happen at registration time.
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // This emails a live payment link to every family on the event. "Is staff"
  // was a looser bar than removing a single registrant (events:edit) — match
  // it. Owners bypass as always.
  const denied = requirePermission(session, "events", "edit");
  if (denied) return denied;

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json().catch(() => ({})));
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    throw err;
  }

  const event = await prisma.event.findFirst({
    where: { id: params.id, clubId: session.user.clubId, deletedAt: null },
    include: { club: true },
  });
  if (!event) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const isVariable = !!event.variableCostEnabled;
  if (!event.club.stripeAccountId || !event.club.stripeChargesEnabled) {
    return NextResponse.json(
      { error: "Connect Stripe before sending invoices." },
      { status: 400 },
    );
  }

  const mode = event.variableCostMode === "OFFICIAL" ? "OFFICIAL" : "ESTIMATED";

  const allActive = await prisma.eventRegistration.findMany({
    where: { eventId: event.id, status: { not: "CANCELED" } },
  });
  const activeCount = allActive.length;
  if (activeCount === 0) {
    return NextResponse.json({ error: "No active registrations to invoice." }, { status: 400 });
  }

  // Fixed-price events: each registrant owes their recorded amountDue (set at
  // registration), falling back to the event's current price. Resolved through
  // the shared helper, which falls through to whatever price the owner set
  // rather than answering 0 when the non-member column happens to be empty.
  const fixedPrice = isVariable ? 0 : registrationListPrice(event);

  // Divisor: actual attendees (OFFICIAL) or expected signups (ESTIMATED).
  const divisor =
    !isVariable || mode === "OFFICIAL"
      ? activeCount
      : event.variableCostEstimatedSignups && event.variableCostEstimatedSignups > 0
        ? event.variableCostEstimatedSignups
        : activeCount;

  // Itemized expense breakdown (P1) takes precedence when present: per-athlete
  // items are charged in full to each registrant; shared items are split across
  // the divisor. With no items, behavior is unchanged (single variableCostTotal).
  const expenseItems = isVariable
    ? await prisma.eventExpenseItem.findMany({
        where: { eventId: event.id, clubId: event.clubId },
        orderBy: { createdAt: "asc" },
      })
    : [];
  const perAthleteSum = expenseItems
    .filter((i) => i.perAthlete)
    .reduce((s, i) => s + Number(i.amount), 0);
  const sharedSum = expenseItems
    .filter((i) => !i.perAthlete)
    .reduce((s, i) => s + Number(i.amount), 0);
  const itemsSum = perAthleteSum + sharedSum;

  let total: number | null = null;
  let perHead: number | null = null;
  if (!isVariable) {
    // Per-registrant amounts resolve inside the send loop (amountDue first).
    perHead = fixedPrice > 0 ? fixedPrice : null;
  } else if (itemsSum > 0) {
    perHead = +(perAthleteSum + sharedSum / divisor).toFixed(2);
    total = +(perAthleteSum * divisor + sharedSum).toFixed(2);
  } else if (mode === "OFFICIAL") {
    if (!event.variableCostTotal || Number(event.variableCostTotal) <= 0) {
      return NextResponse.json(
        { error: "Set the official total cost (or add expense items) before sending invoices." },
        { status: 400 },
      );
    }
    total = Number(event.variableCostTotal);
    perHead = +(total / divisor).toFixed(2);
  } else {
    // ESTIMATED: prefer the entered total, fall back to the display estimate.
    const estTotal =
      event.variableCostTotal != null
        ? Number(event.variableCostTotal)
        : event.variableCostEstimatedTotal != null
          ? Number(event.variableCostEstimatedTotal)
          : 0;
    if (estTotal <= 0) {
      return NextResponse.json(
        { error: "Set an estimated total cost (or add expense items) before sending invoices." },
        { status: 400 },
      );
    }
    total = estTotal;
    perHead = +(total / divisor).toFixed(2);
  }

  if (isVariable && (perHead == null || Math.round(perHead * 100) <= 0)) {
    return NextResponse.json({ error: "Computed share is $0 — check the total and split." }, { status: 400 });
  }

  // Decide which registrants to invoice. SCHEDULED registrants consented to an
  // automatic event-day charge — invoicing them would collect the same money
  // twice, so they're never a target (explicitly or via "all unpaid"). Cancel
  // the scheduled charge first if you mean to bill them another way.
  let targets = allActive.filter((r) => r.status !== "PAID" && r.status !== "SCHEDULED");
  if (body.registrationIds && body.registrationIds.length > 0) {
    const idSet = new Set(body.registrationIds);
    targets = targets.filter((r) => idSet.has(r.id));
  } else if (!body.force) {
    // Default: only registrants who haven't been invoiced yet.
    targets = targets.filter((r) => r.invoiceCount === 0);
  }

  if (targets.length === 0) {
    return NextResponse.json(
      { error: "No matching unpaid registrants to invoice. Use re-send to invoice everyone still unpaid." },
      { status: 400 },
    );
  }

  // ── What each registrant will actually be charged, resolved ONCE ──────────
  // Every surface (this route, the roster row, the cash-entry prompt) reads
  // the same resolver, so the screen can't say one number while the email
  // says another. On a fixed-price event a recorded amountDue still wins —
  // it can legitimately be a per-registrant price — but a figure that differs
  // from the event's own price is surfaced, not silently emailed. That silent
  // path is what mailed five families $533.33 for a $450 camp.
  // Where each link actually goes. This used to read `reg.email` directly and
  // refuse the row when it was blank — which is every minor with no personal
  // address, whose guardian email was on the member record the whole time.
  const recipients = await resolveRegistrationRecipients(event.clubId, targets);

  // The event's LIST price — the headline figure, not any one person's bill.
  const eventExpected = isVariable ? (perHead as number) : expectedAmount(event, activeCount);
  const lines = targets.map((reg) => {
    const recipient = recipients.get(reg.id) ?? null;
    // A discounted registrant legitimately owes less than the list price, so
    // the comparison is against THEIR expectation, not the event's. Without
    // this every discounted row 409s as an AMOUNT_MISMATCH and trains the
    // owner to click past the one warning that caught the $533.33 bug.
    const rowExpected = isVariable
      ? Math.round(
          (perHead as number) * 100 -
            (collectionBreakdown(event, reg, activeCount).discountOff * 100),
        ) / 100
      : expectedAmount(event, activeCount, reg);
    const amount = isVariable ? rowExpected : amountToCollect(event, reg, activeCount);
    // Fee on the DISCOUNTED amount, never the list price.
    const feeCents = event.club.passProcessingFees
      ? computeProcessingFeeCents(Math.round(amount * 100))
      : 0;
    const bd = collectionBreakdown(event, reg, activeCount);
    return {
      registrationId: reg.id,
      name: reg.name,
      email: recipient?.email ?? null,
      emailSource: recipient?.source ?? null,
      emailDisplayName: recipient?.displayName ?? null,
      emailReason: recipient?.reason ?? null,
      status: reg.status,
      recorded: reg.amountDue == null ? null : Number(reg.amountDue),
      amount,
      expected: rowExpected,
      listPrice: eventExpected,
      discountCode: reg.discountCode ?? null,
      discountOff: bd.discountOff,
      mismatch: Math.round(amount * 100) !== Math.round(rowExpected * 100),
      processingFee: feeCents / 100,
      // What the Stripe page will actually total — the club passes fees, so
      // this is higher than the figure in the email body.
      chargedTotal: +(amount + feeCents / 100).toFixed(2),
      alreadyInvoiced: reg.invoiceCount > 0,
    };
  });
  const mismatched = lines.filter((l) => l.mismatch);

  if (body.preview) {
    return NextResponse.json({
      preview: true,
      mode,
      isVariable,
      perHead,
      total,
      divisor,
      attendees: activeCount,
      expected: eventExpected,
      passProcessingFees: event.club.passProcessingFees,
      lines,
      mismatched: mismatched.length,
      grandTotal: +lines.reduce((s, l) => s + l.chargedTotal, 0).toFixed(2),
    });
  }

  if (mismatched.length > 0 && !body.confirmMismatched) {
    return NextResponse.json(
      {
        error: "AMOUNT_MISMATCH",
        message: `${mismatched.length} registrant(s) would be billed an amount that doesn't match this event's price of $${eventExpected.toFixed(2)}. Review them, reprice, or confirm to send anyway.`,
        expected: eventExpected,
        lines: mismatched,
      },
      { status: 409 },
    );
  }

  // getAppBaseUrl(), not baseUrlFromRequest(req): the payer clicks this link
  // out of an email hours or days later, on whatever device they read mail on.
  // A preview-deploy host captured from the staff member's request would be a
  // dead address by then. lib/eventInvoicing builds the return URLs from it.
  const baseUrl = getAppBaseUrl();

  const splitNote = !isVariable
    ? "Event registration"
    : itemsSum > 0
      ? `Your share across ${divisor} attendee${divisor === 1 ? "" : "s"}`
      : mode === "OFFICIAL"
        ? `Official split: $${(total ?? 0).toFixed(2)} ÷ ${activeCount} attendees`
        : `Estimated split: $${(total ?? 0).toFixed(2)} ÷ ${divisor} attendees`;

  // Parent-facing breakdown (same per-head for every registrant): per-athlete
  // items at full price, shared items shown as their per-head split.
  const esc = escapeHtml;
  const breakdownHtml = expenseItems.length
    ? `<table style="width:100%;border-collapse:collapse;margin:4px 0 16px;font-size:14px"><tbody>${expenseItems
        .map((i) => {
          const each = i.perAthlete ? Number(i.amount) : Number(i.amount) / divisor;
          const tag = i.perAthlete ? "per athlete" : `split ÷ ${divisor}`;
          return `<tr><td style="padding:4px 0;color:#57534e">${esc(i.label)}${
            i.description ? ` <span style="color:#a8a29e">— ${esc(i.description)}</span>` : ""
          } <span style="color:#a8a29e">(${tag})</span></td><td style="padding:4px 0;text-align:right;color:#1c1917;white-space:nowrap">$${each.toFixed(2)}</td></tr>`;
        })
        .join(
          "",
        )}</tbody><tfoot><tr><td style="padding-top:8px;border-top:1px solid #e7e5e4;color:#1c1917;font-weight:600">Your total</td><td style="padding-top:8px;border-top:1px solid #e7e5e4;text-align:right;color:#1c1917;font-weight:600">$${(perHead ?? 0).toFixed(
        2,
      )}</td></tr></tfoot></table>`
    : "";

  let billed = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const reg of targets) {
    if (reg.status === "PAID") {
      skipped++;
      continue;
    }
    const recipientEmail = recipients.get(reg.id)?.email ?? null;
    if (!recipientEmail) {
      errors.push(`${reg.name}: ${recipients.get(reg.id)?.reason ?? "no email on file"}`);
      continue;
    }
    // Resolved above (one model for every surface) — never recomputed here,
    // so the preview the owner approved is exactly what gets sent.
    const line = lines.find((l) => l.registrationId === reg.id);
    const amount = line?.amount ?? 0;
    const amountCents = Math.round(amount * 100);
    // The code the registrant already holds rides into the Stripe page and the
    // email, so the reduced figure is explained rather than looking wrong.
    const regCode = line?.discountCode ?? null;
    const regDiscountOff = line?.discountOff ?? 0;
    if (amountCents <= 0) {
      errors.push(`${reg.name}: no price to collect — set a price on the event first`);
      continue;
    }
    // One implementation of "send this person a payment link" — the same one
    // the approve route (§5.4.6 INVOICE) and the escalation cron call.
    const outcome = await billOneRegistrant({
      event: {
        id: event.id,
        clubId: event.clubId,
        name: event.name,
        publicSlug: event.publicSlug,
        isTournament: event.isTournament,
      },
      club: {
        stripeAccountId: event.club.stripeAccountId,
        tier: event.club.tier,
        passProcessingFees: event.club.passProcessingFees,
      },
      registration: { id: reg.id, name: reg.name },
      recipientEmail,
      amount,
      discountCode: regCode,
      discountOff: regDiscountOff,
      kind: isVariable ? "SHARE" : "FEE",
      lineNote: isVariable
        ? splitNote
        : event.isTournament
          ? "Tournament registration"
          : "Event registration",
      productName: isVariable ? `${event.name} — cost share` : event.name,
      breakdownHtml,
      baseUrl,
    });
    if (outcome.ok) billed++;
    else errors.push(`${reg.name} (${recipientEmail}): ${outcome.error}`);
  }

  if (isVariable) {
    await prisma.event.update({
      where: { id: event.id },
      data: { variableCostBilledAt: new Date() },
    });
  }

  return NextResponse.json({
    ok: true,
    mode,
    perHead,
    total,
    divisor,
    attendees: activeCount,
    targeted: targets.length,
    billed,
    skipped,
    errors,
  });
}
