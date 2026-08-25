// Status drift: paid, active, Stripe-billed members left PROSPECT/INACTIVE.
// DRY-RUN by default.
//
//   npx tsx scripts/fix-active-status-drift.ts                       # dry run
//   npx tsx scripts/fix-active-status-drift.ts --apply --members <id|email|name>,…
//
// WHY THESE ROWS EXIST
//   recomputeMemberStatus() only counts a priced RECURRING subscription once a
//   SUCCEEDED Transaction proves money arrived (countsAsMembership, memberTracks).
//   That Transaction is written exclusively by the `invoice.paid` webhook — which
//   until 2026-08-25 did NOT recompute member status. Every activation path
//   (checkout.session.completed, migration approve, reactivation confirm)
//   recomputes BEFORE invoice.paid lands, so their recompute was a no-op and the
//   member kept whatever status they held while the subscription was pending.
//   Members whose invoice.paid happened to be delivered FIRST came out ACTIVE;
//   the rest are stuck. The webhook is fixed; this script repairs the backlog.
//
// WHAT IT DOES — one action, nothing else:
//   STATUS_TO_ACTIVE  member.status PROSPECT|INACTIVE → ACTIVE, when they hold at
//                     least one `active` subscription that countsAsMembership()
//                     accepts. Subscriptions, plans, cards, profile flags and
//                     history are NOT touched. PAUSED is skipped (owner-controlled).
//
// WHAT IT WILL NOT DO
//   It promotes ONLY members with real money proof. A member whose Stripe
//   subscription is active but whose first invoice was $0 (free intro period /
//   future billing anchor) has not bought a membership yet, and countsAsMembership
//   correctly refuses them — the script leaves them PROSPECT. Verified 2026-08-25:
//   Andrew LaFrance and Blake Decker are exactly that case (invoice.paid arrived
//   with amount_paid = 0; first real charge scheduled 2026-09-01 and 2026-08-27).
//   The webhook fix promotes them automatically when that charge lands. This
//   script also never reads or writes Member.commitmentEndDate, minimumTermEndsAt,
//   paidThroughDate or endDate — status only.
//
// --apply REFUSES to run without an explicit --members allowlist. Every write
// records a BillingAuditLog row and is re-read afterwards.
import { PrismaClient } from "@prisma/client";
import { countsAsMembership } from "../lib/memberTracks";

const prisma = new PrismaClient();
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const membersArg = args.includes("--members") ? args[args.indexOf("--members") + 1] : null;
const allow = new Set(
  (membersArg || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
);

if (APPLY && allow.size === 0) {
  console.error("--apply requires an explicit --members <id|email|name>,… allowlist. Run the dry run first.");
  process.exit(1);
}

type Evidence = {
  subId: string;
  optionLabel: string;
  price: string;
  billingType: string;
  stripeSubscriptionId: string | null;
  paid: boolean;
  deliberateFree: boolean;
  startedAt: Date | null;
};

type Action = {
  memberId: string;
  clubId: string;
  name: string;
  email: string | null;
  from: "PROSPECT" | "INACTIVE";
  qualifying: Evidence[];
};

async function collect(): Promise<Action[]> {
  // Candidates: not deleted, not ACTIVE, not PAUSED, and holding at least one
  // active subscription row. The row alone proves nothing — the money check below
  // is what decides.
  const candidates = await prisma.member.findMany({
    where: {
      deletedAt: null,
      status: { in: ["PROSPECT", "INACTIVE"] },
      subscriptions: { some: { status: "active" } },
    },
    select: {
      id: true, clubId: true, firstName: true, lastName: true, email: true, status: true,
      subscriptions: {
        where: { status: "active" },
        select: {
          id: true, optionLabel: true, price: true, billingType: true,
          deliberateFree: true, stripeSubscriptionId: true, startedAt: true,
        },
      },
    },
  });

  // Money proof, one grouped lookup for the whole batch — the same rule
  // recomputeMemberStatus uses (SUCCEEDED, not VOID, keyed by Stripe sub id).
  const stripeIds = candidates
    .flatMap((m) => m.subscriptions.map((s) => s.stripeSubscriptionId))
    .filter((v): v is string => !!v);
  const paidStripe = new Set<string>();
  if (stripeIds.length > 0) {
    const paid = await prisma.transaction.findMany({
      where: {
        stripeSubscriptionId: { in: stripeIds },
        status: "SUCCEEDED",
        reconciliationStatus: { not: "VOID" },
      },
      select: { stripeSubscriptionId: true },
      distinct: ["stripeSubscriptionId"],
    });
    for (const t of paid) if (t.stripeSubscriptionId) paidStripe.add(t.stripeSubscriptionId);
  }

  const actions: Action[] = [];
  for (const m of candidates) {
    const qualifying: Evidence[] = [];
    for (const s of m.subscriptions) {
      const paid = !!(s.stripeSubscriptionId && paidStripe.has(s.stripeSubscriptionId));
      const counts = countsAsMembership({
        status: "active",
        price: s.price == null ? null : Number(s.price),
        billingType: s.billingType,
        deliberateFree: s.deliberateFree,
        hasSucceededPayment: paid,
      });
      if (!counts) continue;
      qualifying.push({
        subId: s.id,
        optionLabel: s.optionLabel,
        price: String(s.price ?? 0),
        billingType: s.billingType,
        stripeSubscriptionId: s.stripeSubscriptionId,
        paid,
        deliberateFree: s.deliberateFree,
        startedAt: s.startedAt,
      });
    }
    if (qualifying.length === 0) continue; // active row, no real membership — correct as-is
    actions.push({
      memberId: m.id,
      clubId: m.clubId,
      name: `${m.firstName} ${m.lastName ?? ""}`.trim(),
      email: m.email,
      from: m.status as "PROSPECT" | "INACTIVE",
      qualifying,
    });
  }
  return actions;
}

function allowed(a: Action): boolean {
  if (allow.size === 0) return true; // dry run shows everything
  return (
    allow.has(a.memberId.toLowerCase()) ||
    (!!a.email && allow.has(a.email.toLowerCase())) ||
    allow.has(a.name.toLowerCase())
  );
}

async function main() {
  const actions = await collect();
  console.log(`\n=== ${APPLY ? "APPLY" : "DRY RUN"} — ${actions.length} member(s) with a real membership but a stale status ===\n`);
  for (const a of actions) {
    const mark = APPLY && !allowed(a) ? "✗ (not in allowlist)" : "→";
    console.log(`${mark} STATUS_TO_ACTIVE  ${a.name} (${a.memberId})  ${a.from} → ACTIVE`);
    for (const q of a.qualifying) {
      const why = q.billingType === "MANUAL"
        ? "MANUAL (exempt from money proof)"
        : Number(q.price) > 0
          ? `paid=${q.paid} via ${q.stripeSubscriptionId ?? "no stripe id"}`
          : `deliberateFree=${q.deliberateFree}`;
      console.log(`      sub ${q.subId} · ${q.optionLabel} · $${q.price} · ${q.billingType} · ${why} · startedAt ${q.startedAt?.toISOString() ?? "—"}`);
    }
  }
  if (!APPLY) {
    console.log("\nDry run only — nothing written. Re-run with --apply --members <ids> after owner approval.");
    return;
  }

  let changed = 0;
  for (const a of actions) {
    if (!allowed(a)) continue;
    // Re-read inside the apply loop: the webhook fix may have healed this member
    // between the dry run and now, and PAUSED is never overridden.
    const member = await prisma.member.findFirst({
      where: { id: a.memberId, clubId: a.clubId },
      select: { id: true, status: true },
    });
    if (!member) {
      console.log(`  skip ${a.name} — member no longer readable`);
      continue;
    }
    if (member.status !== a.from) {
      console.log(`  skip ${a.name} — status is now ${member.status}, not ${a.from}`);
      continue;
    }

    await prisma.member.update({ where: { id: a.memberId }, data: { status: "ACTIVE" } });
    await prisma.billingAuditLog.create({
      data: {
        clubId: a.clubId,
        memberId: a.memberId,
        actorUserId: null, // script actor
        action: "MEMBER_STATUS_CORRECTED_TO_ACTIVE",
        before: { status: a.from },
        after: { status: "ACTIVE" },
        note:
          "SCRIPT_ACTIVE_STATUS_DRIFT (2026-08-25, owner-approved): member held an active, paid membership " +
          `(${a.qualifying.map((q) => `${q.optionLabel} $${q.price} ${q.stripeSubscriptionId ?? "manual"}`).join("; ")}) ` +
          "while Member.status read " + a.from + ". Cause: invoice.paid wrote the money proof but did not " +
          "recompute member status, so the earlier activation-path recompute was a no-op. Status only; no " +
          "subscription, plan, card, or profile data was changed.",
      },
    });

    const after = await prisma.member.findUnique({
      where: { id: a.memberId },
      select: { status: true },
    });
    console.log(`  ✓ ${a.name} (${a.memberId}) — ${a.from} → ${after?.status}`);
    changed++;
  }
  console.log(`\n${changed} member(s) corrected.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
