// Every transactional email a registration produces — plan.md §5.2.4/§5.2.5.
//
// One template, one context, one send function. The body is rendered from the
// §5.2.2 render context, which is the same object the confirmation page
// renders, so an email and the page it links to physically cannot disagree
// about whether someone is registered or what they owe.
//
// Idempotency is structural, not defensive (§5.2.10). Every send goes through
// sendClubEmail with a (sendBatchId, dedupeKey) pair, and the M16 partial
// unique index on email_sends makes a second insert with the same tuple a
// constraint violation that resolves to SKIPPED. That is what makes a webhook
// retry, a cron restart, and a double-tapped button all safe: the caller does
// not have to remember whether it already sent.
//
// Transactional, so EmailOptOut(scope=MARKETING) does not suppress these — a
// parent who unsubscribed from newsletters still gets told their child's
// registration was declined. Only scope=ALL (an explicit "no email at all")
// stops them, which sendClubEmail enforces centrally.

import { prisma } from "@/lib/prisma";
import { sendClubEmail } from "@/lib/sendClubEmail";
import { getAppBaseUrl } from "@/lib/baseUrl";
import { resolveCardSnapshot, prettyBrand } from "@/lib/memberCard";
import { resolveEventPolicy } from "@/lib/eventPayments";
import { resolveRegistrationNotifyRecipients } from "@/lib/eventRecipients";
import {
  renderableRegistrationState,
  type RegistrationRenderContext,
} from "@/lib/registrationRenderState";
import { escapeHtml } from "@/lib/eventInvoicing";
import { labelForChangeKey } from "@/lib/eventCategories";

export type LifecycleTransition =
  | "CONFIRMATION"
  | "APPROVED"
  | "DECLINED"
  | "PROPOSAL"
  | "PROPOSAL_ACCEPTED"
  | "PROPOSAL_DECLINED"
  | "REMINDER";

/** §5.2.5's ledger keys. The proposal key carries the proposal's timestamp so a
 *  REVISED proposal re-notifies while a replay of the same one never does. */
function ledgerKeys(
  transition: LifecycleTransition,
  ctx: RegistrationRenderContext,
  registrationId: string,
  respondedAtKey?: string | null,
): { sendBatchId: string; dedupeKey: string } {
  switch (transition) {
    case "CONFIRMATION":
      return { sendBatchId: "event-confirm", dedupeKey: `event-confirm:${registrationId}` };
    case "APPROVED":
      return { sendBatchId: "event-approved", dedupeKey: `event-approved:${registrationId}` };
    case "DECLINED":
      return { sendBatchId: "event-declined", dedupeKey: `event-declined:${registrationId}` };
    case "PROPOSAL": {
      const at = ctx.meta.proposedChange?.proposedAt.toISOString() ?? "0";
      return { sendBatchId: "event-proposal", dedupeKey: `event-proposal:${registrationId}:${at}` };
    }
    // Keyed on the RESPONSE timestamp, which is set once and never rewritten:
    // a double-tapped Accept produces the same key, so the second request is a
    // no-op at the ledger rather than a second email. The accepted email also
    // stands in for the coach-approved one — acceptance implies approval, and
    // a family should get one message about it, not two.
    case "PROPOSAL_ACCEPTED":
      return {
        sendBatchId: "event-accepted",
        dedupeKey: `event-accepted:${registrationId}:${respondedAtKey ?? "0"}`,
      };
    case "PROPOSAL_DECLINED":
      return {
        sendBatchId: "event-parent-declined",
        dedupeKey: `event-parent-declined:${registrationId}:${respondedAtKey ?? "0"}`,
      };
    // Keyed on the STAGE, so a cron restart mid-pass re-sends nothing and only
    // a genuine stage rotation produces a new row (§5.2.10).
    case "REMINDER":
      return {
        sendBatchId: "event-remind",
        dedupeKey: `event-remind:${registrationId}:${ctx.meta.escalationStage}`,
      };
  }
}

function subjectFor(transition: LifecycleTransition, ctx: RegistrationRenderContext): string {
  const e = ctx.meta.eventName;
  switch (transition) {
    case "CONFIRMATION":
      return ctx.key === "PENDING_REVIEW" ? `Registration requested — ${e}` : `You're registered — ${e}`;
    case "APPROVED":
      return `Your coach approved your registration for ${e}`;
    case "DECLINED":
      return `Your coach couldn't approve your registration for ${e}`;
    case "PROPOSAL":
      return `Your coach proposed a change to your ${e} registration`;
    case "PROPOSAL_ACCEPTED":
      return `You're registered for ${e}`;
    case "PROPOSAL_DECLINED":
      return `Your registration for ${e} was canceled`;
    // Urgency comes from the proximity badge the resolver already computed, so
    // the subject sharpens as the deadline closes without the cron formatting
    // anything itself.
    case "REMINDER": {
      const badge = ctx.meta.proximityBadge;
      const amount = ctx.meta.amountDue != null ? ` — ${money(ctx.meta.amountDue)}` : "";
      if (badge === "TODAY") return `Due today: ${e}${amount}`;
      if (badge === "TOMORROW") return `Due tomorrow: ${e}${amount}`;
      if (badge === "3_DAYS" || badge === "THIS_WEEK") return `Payment due soon for ${e}${amount}`;
      return `Payment reminder — ${e}${amount}`;
    }
  }
}

const money = (n: number) => `$${n.toFixed(2)}`;

function fmtWhen(d: Date, tz?: string | null): string {
  try {
    return d.toLocaleString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      ...(tz ? { timeZone: tz } : {}),
    });
  } catch {
    return d.toISOString();
  }
}

const SEVERITY_COLOR: Record<RegistrationRenderContext["severity"], string> = {
  info: "#534AB7",
  success: "#4d7c0f",
  warn: "#b45309",
  danger: "#b91c1c",
};

/**
 * The email body. Renders the §5.2.7 slots in the §5.2.7 order — the same
 * order, from the same context, as the on-screen card. Fields appear only when
 * their meta value is present; the status badge, headline, charge-timing
 * sentence, confirmation number and event identity always render.
 */
export function renderLifecycleEmailHtml(ctx: RegistrationRenderContext, tz?: string | null): string {
  const m = ctx.meta;
  const rows: string[] = [];
  const row = (label: string, value: string) =>
    `<tr><td style="padding:6px 0;color:#a8a29e;font-size:13px">${escapeHtml(label)}</td><td style="padding:6px 0;text-align:right;color:#1c1917;font-size:13px">${value}</td></tr>`;

  rows.push(row("Confirmation #", `<strong>${escapeHtml(m.confirmationCode)}</strong>`));
  rows.push(row("Event", escapeHtml(m.eventName)));
  rows.push(row("Registered", escapeHtml(m.athleteName)));
  if (m.payerName) rows.push(row("Paid by", escapeHtml(m.payerName)));
  rows.push(row("Date & time", escapeHtml(fmtWhen(m.eventStartsAt, tz))));
  if (m.location) {
    const loc = m.location.directionsUrl
      ? `<a href="${m.location.directionsUrl}" style="color:#534AB7">${escapeHtml(m.location.name)}</a>`
      : escapeHtml(m.location.name);
    rows.push(row("Location", loc));
  }
  if (m.amountPaid) rows.push(row("Amount paid", money(m.amountPaid)));
  if (m.amountDue) rows.push(row("Amount due", money(m.amountDue)));
  if (m.amountRefunded) rows.push(row("Refunded", money(m.amountRefunded)));
  if (m.discountLabel) rows.push(row("Discount", escapeHtml(m.discountLabel)));
  if (m.cardLabel) rows.push(row("Card on file", escapeHtml(m.cardLabel)));
  if (m.dueDate) rows.push(row("Payment due by", escapeHtml(fmtWhen(m.dueDate, tz))));

  const proposal = m.proposedChange
    ? `<table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px">
         <thead><tr>
           <th style="text-align:left;padding:6px 0;color:#a8a29e;font-weight:500">What you signed up for</th>
           <th style="text-align:left;padding:6px 0;color:#a8a29e;font-weight:500">What your coach proposes</th>
         </tr></thead>
         <tbody>${Object.keys(m.proposedChange.proposed)
           .map(
             (k) =>
               `<tr><td style="padding:4px 0;color:#57534e">${escapeHtml(labelForChangeKey(k, m.proposedChange?.labels))}: ${escapeHtml(String(m.proposedChange?.original[k] ?? "—"))}</td><td style="padding:4px 0;color:#1c1917"><strong>${escapeHtml(String(m.proposedChange?.proposed[k] === true ? "Yes" : (m.proposedChange?.proposed[k] ?? "—")))}</strong></td></tr>`,
           )
           .join("")}</tbody>
       </table>
       ${m.proposedChange.priceDelta ? `<p style="color:#b45309;font-size:13px;margin:-8px 0 16px">Price change if you accept: ${money(m.proposedChange.priceDelta)}</p>` : ""}`
    : "";

  const buttons = [ctx.actions.primary, ...ctx.actions.secondary]
    .filter(Boolean)
    .slice(0, 2)
    .map(
      (a, i) =>
        `<a href="${a!.href}" style="display:inline-block;margin-right:8px;background:${i === 0 ? "#534AB7" : "#f5f5f4"};color:${i === 0 ? "#fff" : "#1c1917"};padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">${escapeHtml(a!.label)}</a>`,
    )
    .join("");

  return `
<div style="font-family:Inter,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#1c1917">
  <span style="display:inline-block;background:${SEVERITY_COLOR[ctx.severity]}1a;color:${SEVERITY_COLOR[ctx.severity]};padding:4px 10px;border-radius:999px;font-size:12px;font-weight:600">${escapeHtml(ctx.waitingOnLabel)}</span>
  <h2 style="margin:12px 0 4px;font-size:22px">${escapeHtml(ctx.headline)}</h2>
  ${ctx.subheadline ? `<p style="margin:0 0 12px;color:#57534e;line-height:1.6">${escapeHtml(ctx.subheadline)}</p>` : ""}
  <p style="margin:0 0 18px;color:#1c1917;line-height:1.6"><strong>${escapeHtml(ctx.chargeTiming)}</strong></p>
  ${proposal}
  ${m.declineReason ? `<blockquote style="margin:0 0 18px;padding:10px 14px;border-left:3px solid #e7e5e4;color:#57534e">${escapeHtml(m.declineReason)}</blockquote>` : ""}
  <table style="width:100%;border-collapse:collapse;border-top:1px solid #e7e5e4;border-bottom:1px solid #e7e5e4">${rows.join("")}</table>
  <p style="margin:20px 0">${buttons}</p>
  ${m.cancellationPolicyText ? `<p style="color:#a8a29e;font-size:12px;line-height:1.6">${escapeHtml(m.cancellationPolicyText)}</p>` : ""}
  <p style="color:#a8a29e;font-size:12px;line-height:1.6">
    View this registration any time: <a href="${ctx.confirmationUrl}" style="color:#534AB7">${ctx.confirmationUrl}</a><br/>
    ${escapeHtml(m.clubName)}${m.clubContact ? ` · ${escapeHtml(m.clubContact)}` : ""}
  </p>
  <p style="color:#a8a29e;font-size:11px;line-height:1.6;margin-top:16px">
    This is a transactional notification about your registration for ${escapeHtml(m.eventName)}.
    You'll receive one for every material change.
  </p>
</div>`;
}

export function renderLifecycleEmailText(ctx: RegistrationRenderContext, tz?: string | null): string {
  const m = ctx.meta;
  const lines = [
    ctx.waitingOnLabel.toUpperCase(),
    ctx.headline,
    ...(ctx.subheadline ? [ctx.subheadline] : []),
    "",
    ctx.chargeTiming,
    "",
    `Confirmation #: ${m.confirmationCode}`,
    `Event: ${m.eventName}`,
    `Registered: ${m.athleteName}`,
    `Date & time: ${fmtWhen(m.eventStartsAt, tz)}`,
    ...(m.location ? [`Location: ${m.location.name}`] : []),
    ...(m.amountPaid ? [`Amount paid: ${money(m.amountPaid)}`] : []),
    ...(m.amountDue ? [`Amount due: ${money(m.amountDue)}`] : []),
    ...(m.amountRefunded ? [`Refunded: ${money(m.amountRefunded)}`] : []),
    ...(m.declineReason ? ["", `Reason from your coach: ${m.declineReason}`] : []),
    "",
    ...(ctx.actions.primary ? [`${ctx.actions.primary.label}: ${ctx.actions.primary.href}`] : []),
    `View this registration: ${ctx.confirmationUrl}`,
    "",
    `${m.clubName}${m.clubContact ? ` · ${m.clubContact}` : ""}`,
    `This is a transactional notification about your registration for ${m.eventName}.`,
  ];
  return lines.join("\n");
}

const REG_INCLUDE = {
  event: { include: { customEventType: { select: { defaultPolicy: true } }, location: true } },
  club: {
    select: {
      id: true,
      name: true,
      contactEmail: true,
      contactPhone: true,
      timezone: true,
      stripeAccountId: true,
    },
  },
  member: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      stripeCustomerId: true,
      stripeSetupCustomerId: true,
    },
  },
} as const;

/**
 * Load everything the resolver needs and build the context. This is the only
 * place that does IO for a lifecycle email: the card label comes from Stripe,
 * the active-registration count from the DB (a variable-cost split needs the
 * divisor), and the cancellation policy from the resolved event policy.
 *
 * A Stripe hiccup degrades the card label to null and the copy falls back to
 * "your saved card" — an email that says slightly less is far better than an
 * approval that fails because a card lookup timed out.
 */
export async function loadRegistrationRenderContext(
  registrationId: string,
  opts: {
    baseUrl?: string;
    now?: Date;
    /**
     * The stage a reminder is about to announce. The row still carries the
     * PREVIOUS stage at this point — it is only advanced after the send — so
     * the cron passes the stage it is firing and the copy renders the right
     * urgency rather than the last one's.
     */
    escalationStage?: number;
  } = {},
): Promise<RegistrationRenderContext | null> {
  const reg = await prisma.eventRegistration.findUnique({
    where: { id: registrationId },
    include: REG_INCLUDE,
  });
  if (!reg) return null;

  const activeCount = await prisma.eventRegistration.count({
    where: { eventId: reg.eventId, status: { not: "CANCELED" } },
  });

  let cardLabel: string | null = null;
  const customerId = reg.member?.stripeSetupCustomerId ?? reg.member?.stripeCustomerId ?? null;
  if (customerId && reg.club.stripeAccountId) {
    try {
      const card = await resolveCardSnapshot(customerId, reg.club.stripeAccountId);
      if (card) {
        cardLabel = `${prettyBrand(card.brand)} ····${card.last4}${card.cardholder ? ` (${card.cardholder})` : ""}`;
      }
    } catch (e) {
      console.error("[eventLifecycleEmails] card snapshot failed", e);
    }
  }

  const policy = resolveEventPolicy(reg.event);

  return renderableRegistrationState({
    registration:
      opts.escalationStage != null ? { ...reg, reminderStage: opts.escalationStage } : reg,
    event: reg.event,
    club: reg.club,
    activeCount,
    // No incoming request here (this runs from mutations, webhooks and cron
    // alike), so the context-free base URL is the correct one — §5.6.8.
    baseUrl: opts.baseUrl ?? getAppBaseUrl(),
    now: opts.now,
    cardLabel,
    location: reg.event.location
      ? {
          name: reg.event.location.name,
          address: reg.event.location.address ?? undefined,
          directionsUrl: reg.event.location.address
            ? `https://maps.google.com/?q=${encodeURIComponent(reg.event.location.address)}`
            : undefined,
        }
      : null,
    cancellationPolicyText: policy.cancellationPolicyText,
  });
}

/**
 * Send one lifecycle transition to the registrant and every guardian.
 *
 * One EmailSend row per recipient, all sharing the transition's dedupeKey, so
 * a replay is a no-op per address rather than per message. Never throws: an
 * email problem must not roll back an approval that already moved money.
 */
export async function sendRegistrationLifecycleEmail(args: {
  registrationId: string;
  transition: LifecycleTransition;
  ctx?: RegistrationRenderContext;
  actorUserId?: string | null;
  /** ISO timestamp of the parent's response — keys the two response emails. */
  respondedAt?: string | null;
}): Promise<{ sent: number; skipped: number }> {
  let sent = 0;
  let skipped = 0;
  try {
    const reg = await prisma.eventRegistration.findUnique({
      where: { id: args.registrationId },
      select: { id: true, clubId: true, eventId: true, name: true, email: true, memberId: true },
    });
    if (!reg) return { sent, skipped };

    const ctx = args.ctx ?? (await loadRegistrationRenderContext(args.registrationId));
    if (!ctx) return { sent, skipped };

    const club = await prisma.club.findUnique({
      where: { id: reg.clubId },
      select: { name: true, timezone: true },
    });
    const recipients = await resolveRegistrationNotifyRecipients(reg.clubId, reg);
    const { sendBatchId, dedupeKey } = ledgerKeys(args.transition, ctx, reg.id, args.respondedAt);
    const html = renderLifecycleEmailHtml(ctx, club?.timezone);
    const text = renderLifecycleEmailText(ctx, club?.timezone);
    const subject = subjectFor(args.transition, ctx);

    for (const r of recipients) {
      try {
        const res = await sendClubEmail({
          clubId: reg.clubId,
          kind: "TRANSACTIONAL",
          recipientEmail: r.email,
          recipientUserId: r.userId,
          recipientMemberId: r.memberId,
          subject,
          bodyHtml: html,
          bodyText: text,
          fromName: club?.name ?? null,
          sendBatchId,
          dedupeKey,
          relatedEventId: reg.eventId,
          sentByUserId: args.actorUserId ?? null,
        });
        if (res.status === "SENT") sent++;
        else skipped++;
      } catch (e) {
        console.error("[eventLifecycleEmails] send failed", args.transition, r.email, e);
        skipped++;
      }
    }
  } catch (e) {
    console.error("[eventLifecycleEmails] lifecycle email failed", args.transition, e);
  }
  return { sent, skipped };
}

// ── Coach daily digest (§5.6.7, §5.2.5 row 12) ──────────────────────────────
// Different data from every other send in this file: it is about a QUEUE, not
// about one registration, so it doesn't route through the render context. It
// still goes through sendClubEmail, still transactional, still dedupe-keyed —
// by coach and by calendar day in the club's own timezone, so a cron that
// fires either side of 09:00 produces one email rather than two.

export type DigestRow = {
  registrationId: string;
  athleteName: string;
  eventId: string;
  eventName: string;
  daysWaiting: number;
};

export async function sendCoachDigestEmail(args: {
  clubId: string;
  coachUserId: string;
  coachEmail: string;
  coachFirstName: string | null;
  rows: DigestRow[];
  /** YYYY-MM-DD in the club's own calendar — the dedupe key's day part. */
  dayKey: string;
}): Promise<{ sent: boolean }> {
  if (args.rows.length === 0) return { sent: false };
  try {
    const club = await prisma.club.findUnique({
      where: { id: args.clubId },
      select: { name: true },
    });
    const base = getAppBaseUrl();
    const oldest = Math.max(...args.rows.map((r) => r.daysWaiting));

    const lines = args.rows
      .map(
        (r) =>
          `<tr><td style="padding:6px 0;color:#1c1917;font-size:13px">${escapeHtml(r.athleteName)}<br/><span style="color:#a8a29e">${escapeHtml(r.eventName)}</span></td><td style="padding:6px 0;text-align:right;color:${r.daysWaiting >= 3 ? "#b45309" : "#57534e"};font-size:13px;white-space:nowrap">${r.daysWaiting === 0 ? "today" : `${r.daysWaiting}d`}</td></tr>`,
      )
      .join("");

    const html = `
<div style="font-family:Inter,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#1c1917">
  <h2 style="margin:0 0 4px;font-size:20px">${args.rows.length} registration${args.rows.length === 1 ? "" : "s"} waiting on you</h2>
  <p style="margin:0 0 16px;color:#57534e;line-height:1.6">
    ${args.coachFirstName ? `${escapeHtml(args.coachFirstName)}, these` : "These"} families are waiting for a yes or no.
    ${oldest >= 3 ? `The longest has been waiting ${oldest} days.` : ""}
    Nobody holds a spot and nothing is charged until you decide.
  </p>
  <table style="width:100%;border-collapse:collapse;border-top:1px solid #e7e5e4;border-bottom:1px solid #e7e5e4">${lines}</table>
  <p style="margin:20px 0">
    <a href="${base}/dashboard/events" style="display:inline-block;background:#534AB7;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">Review them</a>
  </p>
  <p style="color:#a8a29e;font-size:11px;line-height:1.6">
    ${escapeHtml(club?.name ?? "Your club")} · you're getting this because you're the responsible coach for these events.
    It stops as soon as the queue is empty.
  </p>
</div>`;

    const text = [
      `${args.rows.length} registration(s) waiting on you`,
      "",
      ...args.rows.map((r) => `· ${r.athleteName} — ${r.eventName} (${r.daysWaiting === 0 ? "today" : `${r.daysWaiting}d`})`),
      "",
      `Review them: ${base}/dashboard/events`,
    ].join("\n");

    const res = await sendClubEmail({
      clubId: args.clubId,
      kind: "TRANSACTIONAL",
      recipientEmail: args.coachEmail,
      recipientUserId: args.coachUserId,
      subject: `${args.rows.length} registration${args.rows.length === 1 ? "" : "s"} waiting on you`,
      bodyHtml: html,
      bodyText: text,
      fromName: club?.name ?? null,
      sendBatchId: "coach-digest",
      dedupeKey: `coach-digest:${args.coachUserId}:${args.dayKey}`,
    });
    return { sent: res.status === "SENT" };
  } catch (e) {
    console.error("[eventLifecycleEmails] coach digest failed", args.coachUserId, e);
    return { sent: false };
  }
}
