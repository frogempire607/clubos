/**
 * Members holding a live subscription whose Member.status still reads
 * PROSPECT/INACTIVE. DRY RUN BY DEFAULT.
 *
 *   npx tsx scripts/fix-member-status-from-subscriptions.ts                 # dry run, every row printed
 *   npx tsx scripts/fix-member-status-from-subscriptions.ts --apply         # write
 *   npx tsx scripts/fix-member-status-from-subscriptions.ts --apply --members <id|email|name>,…
 *
 * ── What it decides, and why it may promote fewer than it lists ─────────────
 *
 * Measured 2026-09-28: 7 members with a live Stripe subscription created
 * Sep 21–27 (online signup) read PROSPECT. This script prints every such
 * member with the evidence for each live subscription and a diagnosis, then
 * promotes ONLY the ones the app's own status rule accepts
 * (lib/memberStatus.recomputeMemberStatus → countsAsMembership):
 *
 *   PAID_STATUS_MISSED      money arrived (a SUCCEEDED transaction for this
 *                           Stripe subscription) but the status never flipped
 *                           → PROMOTED.
 *   MANUAL                  cash/check row — exempt from the money test → PROMOTED.
 *   FREE_TRIAL_NOT_CHARGED  Stripe's first invoice was $0 (a free trial /
 *                           future first charge). Owner-confirmed rule
 *                           (2026-07-13): a trialist is not yet a member. NOT
 *                           promoted — invoice.paid promotes them the moment the
 *                           first real charge lands. Forcing ACTIVE here would
 *                           be undone by the next recompute (stripe sync,
 *                           payment failure) and land them INACTIVE — "former
 *                           member" — which is worse.
 *   INVOICE_PAID_NOT_RECORDED  Stripe sent a paid invoice (> $0) for this
 *                           subscription but no transaction exists — a webhook
 *                           delivery that failed. NOT promoted: run the Stripe
 *                           reconcile for that member first (it records the
 *                           money and recomputes), then re-run this.
 *   NO_PAYMENT_EVENT        no invoice.paid event stored for this subscription
 *                           at all. NOT promoted — check the Connect webhook
 *                           endpoint delivers invoice.paid.
 *   UNPAID_ZERO_PRICE       $0 row not marked as a deliberate comp. NOT promoted.
 *
 * The status write is recomputeMemberStatus — the same function the webhook
 * calls — so this can never write a status the app would disagree with. PAUSED
 * members are never listed or touched. Subscriptions, plans, cards and money
 * are never modified. Every write records a BillingAuditLog row and is re-read.
 */
import { prisma } from "../lib/prisma";
import { countsAsMembership } from "../lib/memberTracks";
import { recomputeMemberStatus } from "../lib/memberStatus";
import { LIVE_SUBSCRIPTION_STATUSES } from "../lib/billingDataRules";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const membersArg = argv.includes("--members") ? argv[argv.indexOf("--members") + 1] : null;
const allow = new Set((membersArg || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));

type Diagnosis =
  | "PAID_STATUS_MISSED"
  | "MANUAL"
  | "DELIBERATE_FREE"
  | "FREE_TRIAL_NOT_CHARGED"
  | "INVOICE_PAID_NOT_RECORDED"
  | "NO_PAYMENT_EVENT"
  | "UNPAID_ZERO_PRICE";

type WebhookRow = { type: string; processed: boolean; errorMessage: string | null; amountPaid: string | null; createdAt: Date };

async function webhookEventsFor(stripeSubscriptionId: string): Promise<WebhookRow[]> {
  // Payloads carry the subscription id in different places across API
  // versions (legacy invoice.subscription, clover parent.subscription_details)
  // — a text match finds it in either.
  return prisma.$queryRaw<WebhookRow[]>`
    SELECT type, processed, "errorMessage",
           payload->'data'->'object'->>'amount_paid' AS "amountPaid",
           "createdAt"
    FROM stripe_webhook_events
    WHERE type IN ('invoice.paid', 'invoice.payment_failed', 'checkout.session.completed')
      AND payload::text LIKE ${"%" + stripeSubscriptionId + "%"}
    ORDER BY "createdAt" ASC`;
}

const fmt = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 16).replace("T", " ") : "—");

async function main() {
  const candidates = await prisma.member.findMany({
    where: {
      deletedAt: null,
      status: { in: ["PROSPECT", "INACTIVE"] },
      subscriptions: { some: { status: { in: [...LIVE_SUBSCRIPTION_STATUSES] } } },
    },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    select: {
      id: true, clubId: true, firstName: true, lastName: true, email: true, status: true,
      subscriptions: {
        where: { status: { in: [...LIVE_SUBSCRIPTION_STATUSES] } },
        orderBy: { createdAt: "asc" },
        select: {
          id: true, optionLabel: true, price: true, billingType: true, status: true, stripeStatus: true,
          deliberateFree: true, stripeSubscriptionId: true, createdAt: true,
          membership: { select: { name: true } },
        },
      },
    },
  });

  const stripeIds = candidates.flatMap((m) => m.subscriptions.map((s) => s.stripeSubscriptionId)).filter((v): v is string => !!v);
  const paid = stripeIds.length
    ? await prisma.transaction.findMany({
        where: { stripeSubscriptionId: { in: stripeIds }, status: "SUCCEEDED", reconciliationStatus: { not: "VOID" } },
        select: { stripeSubscriptionId: true, amount: true, createdAt: true },
      })
    : [];
  const paidBySub = new Map<string, { amount: number; at: Date }[]>();
  for (const t of paid) {
    if (!t.stripeSubscriptionId) continue;
    const list = paidBySub.get(t.stripeSubscriptionId) ?? [];
    list.push({ amount: Number(t.amount), at: t.createdAt });
    paidBySub.set(t.stripeSubscriptionId, list);
  }

  console.log(`\n=== ${APPLY ? "APPLY" : "DRY RUN"} — ${candidates.length} member(s) with a live subscription but status PROSPECT/INACTIVE ===\n`);

  const promote: typeof candidates = [];
  const counts: Record<string, number> = {};
  for (const m of candidates) {
    const name = `${m.firstName} ${m.lastName ?? ""}`.trim();
    let qualifies = false;
    const lines: string[] = [];
    for (const s of m.subscriptions) {
      const price = Number(s.price ?? 0);
      const money = s.stripeSubscriptionId ? paidBySub.get(s.stripeSubscriptionId) ?? [] : [];
      const counted = countsAsMembership({
        status: "active",
        price,
        billingType: s.billingType,
        deliberateFree: s.deliberateFree,
        hasSucceededPayment: money.length > 0,
      });
      let diagnosis: Diagnosis;
      let evidence = "";
      if (s.billingType === "MANUAL") diagnosis = "MANUAL";
      else if (price <= 0) diagnosis = s.deliberateFree ? "DELIBERATE_FREE" : "UNPAID_ZERO_PRICE";
      else if (money.length > 0) {
        diagnosis = "PAID_STATUS_MISSED";
        evidence = `paid ${money.map((x) => `$${x.amount.toFixed(2)} @ ${fmt(x.at)}`).join(", ")}`;
      } else {
        const events = s.stripeSubscriptionId ? await webhookEventsFor(s.stripeSubscriptionId) : [];
        const invoicePaid = events.filter((e) => e.type === "invoice.paid");
        const paidPositive = invoicePaid.filter((e) => Number(e.amountPaid ?? 0) > 0);
        const zero = invoicePaid.filter((e) => Number(e.amountPaid ?? 0) === 0);
        if (paidPositive.length > 0) diagnosis = "INVOICE_PAID_NOT_RECORDED";
        else if (zero.length > 0 || s.stripeStatus === "trialing") diagnosis = "FREE_TRIAL_NOT_CHARGED";
        else diagnosis = "NO_PAYMENT_EVENT";
        evidence =
          `webhooks: ${events.length === 0 ? "none stored" : events.map((e) =>
            `${e.type}${e.amountPaid != null ? ` amount_paid=${e.amountPaid}` : ""}${e.processed ? "" : " UNPROCESSED"}${e.errorMessage ? ` ERROR="${e.errorMessage.slice(0, 80)}"` : ""} @ ${fmt(e.createdAt)}`,
          ).join(" | ")}`;
      }
      counts[diagnosis] = (counts[diagnosis] ?? 0) + 1;
      // recomputeMemberStatus reads `active` rows only — a past_due row is a
      // money problem, not a new membership, and is listed but never promotes.
      if (counted && s.status === "active") qualifies = true;
      lines.push(
        `      sub ${s.id} · ${s.membership?.name ?? "?"} — ${s.optionLabel} · $${price.toFixed(2)} · ${s.billingType} · ` +
          `status ${s.status}/${s.stripeStatus ?? "—"} · ${s.stripeSubscriptionId ?? "no stripe id"} · created ${fmt(s.createdAt)}\n` +
          `        → ${diagnosis}${counted ? (s.status === "active" ? " (counts as a membership)" : " (past_due — not promoted)") : ""}${evidence ? ` · ${evidence}` : ""}`,
      );
    }
    const inAllow =
      allow.size === 0 ||
      allow.has(m.id.toLowerCase()) ||
      (!!m.email && allow.has(m.email.toLowerCase())) ||
      allow.has(name.toLowerCase());
    const verdict = qualifies ? (inAllow ? `${m.status} → ACTIVE` : `${m.status} → ACTIVE  (✗ not in --members, skipped)`) : `stays ${m.status}`;
    console.log(`${qualifies ? "→" : "·"} ${name} (${m.id}) <${m.email ?? "no email"}>  ${verdict}`);
    for (const l of lines) console.log(l);
    if (qualifies && inAllow) promote.push(m);
  }

  console.log(`\nDiagnoses (per subscription): ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join("  ") || "none"}`);
  console.log(`${promote.length} member(s) would be promoted; ${candidates.length - promote.length} stay as they are.`);

  if (!APPLY) {
    console.log("\nDry run only — nothing written. Re-run with --apply (optionally --members <ids>) to write.");
    return;
  }

  let changed = 0;
  for (const m of promote) {
    const name = `${m.firstName} ${m.lastName ?? ""}`.trim();
    const before = await prisma.member.findUnique({ where: { id: m.id }, select: { status: true } });
    if (!before || before.status !== m.status) {
      console.log(`  skip ${name} — status is now ${before?.status ?? "unreadable"}, not ${m.status}`);
      continue;
    }
    const next = await recomputeMemberStatus(m.id, m.clubId);
    const after = await prisma.member.findUnique({ where: { id: m.id }, select: { status: true } });
    if (next) {
      await prisma.billingAuditLog.create({
        data: {
          clubId: m.clubId,
          memberId: m.id,
          actorUserId: null,
          action: "MEMBER_STATUS_CORRECTED_TO_ACTIVE",
          before: { status: m.status },
          after: { status: after?.status ?? next },
          note:
            "SCRIPT fix-member-status-from-subscriptions (2026-09-28): member held a live, paid membership while " +
            `Member.status read ${m.status}. Written by recomputeMemberStatus — status only; no subscription, plan, ` +
            "card or money was changed.",
        },
      });
      changed++;
    }
    console.log(`  ${next ? "✓" : "·"} ${name} (${m.id}) — ${m.status} → ${after?.status}`);
  }
  console.log(`\n${changed} member(s) corrected.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
