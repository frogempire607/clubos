/**
 * The Shannan Hall acceptance case, reproduced locally.
 *
 * Builds the exact shape that blocked her: a guardian, a minor with a MANUAL
 * membership whose commitment ended weeks ago but whose subscription row has no
 * endDate, and an MS/HS plan carrying the post-Step-4 option set.
 *
 *   npx tsx scripts/seed-shannan-buys.ts
 */
import { prisma } from "../lib/prisma";
import bcrypt from "bcryptjs";
import { serializeOptions, makeOption } from "../lib/membershipOptions";

async function main() {
  const club = await prisma.club.findFirst({ where: { slug: "frog-empire" }, select: { id: true } });
  if (!club) throw new Error("Seed the base club first (scripts/seed-local-browser-test.ts).");
  const clubId = club.id;
  const hash = await bcrypt.hash("localtest123", 10);

  // Stripe must be "on" for the club or the card path refuses before it starts.
  // The key itself is blank under dev-local.sh, so nothing can actually reach
  // Stripe — the checkout call fails loudly, which is what we want to observe.
  await prisma.club.update({
    where: { id: clubId },
    data: { stripeAccountId: "acct_localfixture", stripeChargesEnabled: true, passProcessingFees: true },
  });

  // The plan, with the option set Step 4 produces.
  const options = [
    makeOption({ id: "opt_vavjt5xoqc", label: "Monthly Full Membership", price: 175, billingPeriod: "MONTHLY", contractMonths: 1, autoRenewDefault: false }),
    makeOption({ id: "opt_078e5udfsb", label: "3 months Upfront", price: 450, billingPeriod: "QUARTERLY", contractMonths: 3, autoRenewDefault: false }),
    makeOption({ id: "opt_yci81fy0r7", label: "3 Months", price: 160, billingPeriod: "MONTHLY", contractMonths: 3, autoRenewDefault: false }),
  ];
  const plan = await prisma.membership.upsert({
    where: { id: "mship_mshs_local" },
    update: { options: serializeOptions(options), contractMonths: null, active: true },
    create: {
      id: "mship_mshs_local", clubId, name: "MS/HS", active: true,
      contractMonths: null, autoRenewDefault: true,
      options: serializeOptions(options),
    },
  });

  // Guardian account.
  const guardian = await prisma.user.upsert({
    where: { clubId_email: { clubId, email: "shannan@local.test" } },
    update: { passwordHash: hash, deletedAt: null },
    create: {
      clubId, email: "shannan@local.test", passwordHash: hash,
      firstName: "Shannan", lastName: "Hall", role: "MEMBER",
    },
  });

  // The minor. commitmentEndDate in the past; subscription endDate NULL — the
  // divergence that carried him as active.
  const endedOn = new Date(Date.now() - 10 * 864e5);
  const member = await prisma.member.upsert({
    where: { id: "m_max_local" },
    update: { commitmentEndDate: endedOn, status: "ACTIVE", membershipId: plan.id },
    create: {
      id: "m_max_local", clubId, firstName: "Max", lastName: "Hall",
      isMinor: true, guardianEmail: "shannan@local.test", guardianName: "Shannan Hall",
      status: "ACTIVE", membershipId: plan.id,
      commitmentEndDate: endedOn,
      billingAnchorDate: new Date(Date.now() - 40 * 864e5),
      stripeSetupCustomerId: "cus_localfixture",
      stripeSetupPaymentMethodId: "pm_localfixture",
    },
  });

  await prisma.memberGuardianUser.upsert({
    where: { userId_memberId: { userId: guardian.id, memberId: member.id } },
    update: {},
    create: { userId: guardian.id, memberId: member.id, clubId },
  });

  await prisma.memberSubscription.deleteMany({ where: { memberId: member.id } });
  const sub = await prisma.memberSubscription.create({
    data: {
      memberId: member.id, membershipId: plan.id,
      optionId: "opt_vavjt5xoqc", optionLabel: "Monthly",
      price: 175, billingPeriod: "MONTHLY", billingType: "MANUAL",
      status: "active", autoRenew: false,
      startDate: new Date(Date.now() - 130 * 864e5),
      endDate: null,            // ← the gap
      currentPeriodEnd: null,
      paidThroughDate: null,
      notes: "Manual billing — club collects payment offline",
    },
    select: { id: true },
  });

  console.log(`Club        ${clubId} (Stripe enabled, fee passthrough ON)`);
  console.log(`Plan        ${plan.id}  MS/HS — 3 options`);
  console.log(`Guardian    shannan@local.test / localtest123 / frog-empire`);
  console.log(`Member      ${member.id}  Max Hall — commitmentEndDate ${endedOn.toISOString().slice(0,10)}`);
  console.log(`Sub         ${sub.id}  active, MANUAL, endDate NULL  ← reproduces the dead end`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
