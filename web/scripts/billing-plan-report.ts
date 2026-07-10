/**
 * Billing migration plan report — READ ONLY. Prints every migrating member's
 * reviewed plan: triage group, final action, resolved price/cadence, the
 * owner-approved final billing date, charge timing, saved-payment-method
 * state, readiness, and any open reactivation offer. Writes NOTHING — no
 * Stripe calls, no DB mutations. Safe to run any time.
 *
 * Usage (from web/):
 *   npx tsx scripts/billing-plan-report.ts                # table to stdout
 *   npx tsx scripts/billing-plan-report.ts --club <id>
 *   npx tsx scripts/billing-plan-report.ts --csv          # CSV to stdout
 */
import { prisma } from "../lib/prisma";
import { deriveReadiness, resolveOfferPricing, READINESS_LABELS } from "../lib/billingAdmin";

const CSV = process.argv.includes("--csv");
const clubArgIdx = process.argv.indexOf("--club");
const CLUB_FILTER = clubArgIdx >= 0 ? process.argv[clubArgIdx + 1] : null;

const esc = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function main() {
  const clubs = await prisma.club.findMany({
    where: { ...(CLUB_FILTER ? { id: CLUB_FILTER } : {}), deletedAt: null },
    select: { id: true, name: true, stripeAccountId: true, stripeChargesEnabled: true },
  });

  const rows: string[][] = [];
  const now = new Date();

  for (const club of clubs) {
    const members = await prisma.member.findMany({
      where: { clubId: club.id, deletedAt: null, migrationStatus: { not: null } },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      select: {
        id: true, firstName: true, lastName: true, isMinor: true, email: true, guardianEmail: true,
        migrationStatus: true, approvalStatus: true, requestedPaymentMethod: true,
        legacyMembershipName: true, legacyMembershipPrice: true, legacyBillingFrequency: true,
        migrationMembershipId: true, migrationSelectedOption: true, migrationPriceOverride: true,
        migrationFinalPeriodPaid: true, migrationGroup: true, migrationFinalAction: true,
        migrationGroupNote: true, migrationFinalBillingDate: true, billingAnchorDate: true,
        stripeSetupPaymentMethodId: true,
        subscriptions: { select: { status: true, stripeSubscriptionId: true, stripeStatus: true, billingType: true } },
        reactivations: { orderBy: { createdAt: "desc" }, take: 1, select: { status: true, emailSentAt: true } },
      },
    });
    if (!members.length) continue;

    const planIds = [...new Set(members.map((m) => m.migrationMembershipId).filter((x): x is string => !!x))];
    const plans = planIds.length
      ? await prisma.membership.findMany({
          where: { id: { in: planIds } },
          select: { id: true, name: true, options: true },
        })
      : [];
    const planById = new Map(plans.map((p) => [p.id, p]));
    const LIVE = new Set(["active", "trialing", "past_due", "unpaid"]);

    if (!CSV) console.log(`\n=== ${club.name} (${club.id}) — ${members.length} migrating member(s) ===\n`);

    for (const m of members) {
      const plan = m.migrationMembershipId ? planById.get(m.migrationMembershipId) ?? null : null;
      const pricing = resolveOfferPricing(
        {
          legacyMembershipName: m.legacyMembershipName,
          legacyMembershipPrice: m.legacyMembershipPrice as unknown as string | null,
          legacyBillingFrequency: m.legacyBillingFrequency,
          migrationSelectedOption: m.migrationSelectedOption,
          migrationPriceOverride: m.migrationPriceOverride as unknown as string | null,
        },
        plan ? { name: plan.name, options: plan.options } : null,
      );
      const hasPlan = !!plan || !!m.legacyMembershipName;
      const hasLiveStripeSub = m.subscriptions.some(
        (s) => s.stripeSubscriptionId && (s.status === "active" || s.status === "past_due") && (!s.stripeStatus || LIVE.has(s.stripeStatus)),
      );
      const offlineIntended =
        !club.stripeAccountId || !club.stripeChargesEnabled ||
        m.requestedPaymentMethod === "CASH" || m.requestedPaymentMethod === "CHECK";
      const finalDate = m.migrationFinalBillingDate ?? m.billingAnchorDate ?? null;
      const readiness = deriveReadiness({
        migrationGroup: m.migrationGroup,
        migrationFinalAction: m.migrationFinalAction,
        migrationStatus: m.migrationStatus,
        approvalStatus: m.approvalStatus,
        price: hasPlan || m.migrationPriceOverride != null ? pricing.price : null,
        hasPlan,
        hasCapturedCard: !!m.stripeSetupPaymentMethodId,
        offlineIntended,
        finalPeriodPaid: m.migrationFinalPeriodPaid,
        finalBillingDate: finalDate,
        hasLiveStripeSub,
        reactivationStatus: m.reactivations[0]?.status ?? null,
        now,
      });
      const timing = !finalDate
        ? "no date"
        : finalDate.getTime() <= now.getTime() + 60_000
          ? `PAST (${finalDate.toISOString().slice(0, 10)}) — would charge immediately`
          : `future ${finalDate.toISOString().slice(0, 10)}`;

      rows.push([
        `${m.firstName} ${m.lastName}`.trim(),
        m.isMinor ? "minor" : "",
        m.email || m.guardianEmail || "",
        pricing.planName,
        pricing.price ? `$${pricing.price.toFixed(2)}/${pricing.period}` : "free",
        m.migrationGroup || "-",
        m.migrationFinalAction || "-",
        timing,
        m.stripeSetupPaymentMethodId ? "card saved" : offlineIntended ? "offline" : "NO CARD",
        `${m.migrationStatus}${m.approvalStatus ? `/${m.approvalStatus}` : ""}`,
        m.reactivations[0] ? `offer ${m.reactivations[0].status}` : "-",
        READINESS_LABELS[readiness.state],
        readiness.reasons.join("; "),
        m.migrationGroupNote || "",
      ]);
    }
  }

  const header = [
    "Name", "Minor", "Contact", "Plan", "Price", "Group", "Final action", "Charge timing",
    "Payment method", "Status", "Reactivation", "Readiness", "Readiness notes", "Triage note",
  ];
  if (CSV) {
    console.log(header.join(","));
    rows.forEach((r) => console.log(r.map(esc).join(",")));
  } else {
    for (const r of rows) {
      console.log(
        `  ${r[0]}${r[1] ? ` (${r[1]})` : ""} — ${r[3]} ${r[4]}\n` +
          `    group=${r[5]} action=${r[6]} · ${r[7]} · ${r[8]} · ${r[9]} · ${r[10]}\n` +
          `    readiness: ${r[11]}${r[12] ? ` (${r[12]})` : ""}${r[13] ? `\n    note: ${r[13]}` : ""}`,
      );
    }
    console.log(`\n${rows.length} member(s). Read-only report — nothing was changed.`);
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
