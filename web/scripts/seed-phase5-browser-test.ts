/**
 * Local-only fixture seed for BROWSER TESTING the Phase 5 tournament workflow.
 * Never run against production — refuses anything that is not localhost.
 *
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:55432/clubos \
 *     npx tsx scripts/seed-phase5-browser-test.ts
 *
 * Builds on scripts/seed-local-browser-test.ts (same club, same owner login)
 * and adds what the coach-review and parent-response screens need: an
 * approval-gated tournament, a responsible coach whose ONLY route to approving
 * is Event.responsibleCoachUserId, a custom event type carrying a policy so
 * the inheritance path is clickable, and registrations sitting in each of the
 * states the roster has to render.
 *
 * Logins (all password `localtest123`):
 *   owner@local.test  — owner, sees everything
 *   coach@local.test  — STAFF with events:view only; can still decide THIS event
 *   parent@local.test — guardian of the minor with the coach's proposal
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const url = process.env.DATABASE_URL ?? "";
if (!/(127\.0\.0\.1|localhost)/.test(url)) {
  console.error("REFUSING: DATABASE_URL is not localhost. This seed is local-only.");
  process.exit(1);
}

const prisma = new PrismaClient();
const day = 86_400_000;
const ahead = (n: number) => new Date(Date.now() + n * day);

async function main() {
  const clubId = "club_local";
  const hash = await bcrypt.hash("localtest123", 10);

  // Stripe stays OFF for this club on purpose: the browser test drives the
  // decision flow, and a live Connect account plus the real secret key in .env
  // would make an approval a real charge. The INVOICE / cash / free paths
  // exercise everything that matters without money.
  await prisma.club.update({
    where: { id: clubId },
    data: { passProcessingFees: true, timezone: "America/Chicago" },
  });

  const coach = await prisma.user.upsert({
    where: { clubId_email: { clubId, email: "coach@local.test" } },
    update: { passwordHash: hash },
    create: {
      clubId,
      email: "coach@local.test",
      passwordHash: hash,
      firstName: "Reggie",
      lastName: "Okafor",
      role: "STAFF",
    },
  });
  await prisma.staffProfile.upsert({
    where: { userId: coach.id },
    update: { permissions: { events: "view" } },
    // events:view only. Approving is normally events:edit, so if this user can
    // decide a registration it is BECAUSE they are the event's responsible
    // coach — which is the override worth testing.
    create: { userId: coach.id, title: "Head Coach", permissions: { events: "view" } },
  });

  const parent = await prisma.user.upsert({
    where: { clubId_email: { clubId, email: "parent@local.test" } },
    update: { passwordHash: hash },
    create: {
      clubId,
      email: "parent@local.test",
      passwordHash: hash,
      firstName: "Shannan",
      lastName: "Hall",
      role: "MEMBER",
    },
  });

  const athlete = await prisma.member.upsert({
    where: { id: "m_p5_athlete" },
    update: {},
    create: {
      id: "m_p5_athlete",
      clubId,
      firstName: "Cameron",
      lastName: "Hall",
      isMinor: true,
      status: "ACTIVE",
      guardianName: "Shannan Hall",
      guardianEmail: "parent@local.test",
      email: "parent@local.test",
    },
  });
  await prisma.memberGuardianUser.upsert({
    where: { userId_memberId: { userId: parent.id, memberId: athlete.id } },
    update: { status: "CONFIRMED" },
    create: { clubId, memberId: athlete.id, userId: parent.id, status: "CONFIRMED" },
  });

  const teammate = await prisma.member.upsert({
    where: { id: "m_p5_teammate" },
    update: {},
    create: {
      id: "m_p5_teammate",
      clubId,
      firstName: "Drayke",
      lastName: "Ulrich",
      isMinor: true,
      status: "ACTIVE",
      guardianName: "Christina Ulrich",
      guardianEmail: "christina@local.test",
      email: "christina@local.test",
    },
  });

  // A custom type that CARRIES a policy — this is what makes the event
  // editor's approval card appear for a non-tournament type.
  await prisma.clubEventType.upsert({
    where: { id: "cet_p5_dual" },
    update: {
      defaultPolicy: {
        requiresCoachApproval: true,
        approvalPaymentIntent: "PARENT_CHOOSES",
        allowProposedChanges: true,
        cancellationPolicyText: "Entry fees are non-refundable within 7 days of the meet.",
      },
    },
    create: {
      id: "cet_p5_dual",
      clubId,
      name: "Dual Meet",
      color: "#E8DEF8",
      textColor: "#4A3F6B",
      sortOrder: 5,
      defaultPolicy: {
        requiresCoachApproval: true,
        approvalPaymentIntent: "PARENT_CHOOSES",
        allowProposedChanges: true,
        cancellationPolicyText: "Entry fees are non-refundable within 7 days of the meet.",
      },
    },
  });

  // A plain custom type with NO policy, so the editor's "hidden unless opted
  // in" rule is visible as a difference between two types.
  await prisma.clubEventType.upsert({
    where: { id: "cet_p5_clinic" },
    update: {},
    create: {
      id: "cet_p5_clinic",
      clubId,
      name: "Weekly Clinic",
      color: "#DCEFE4",
      textColor: "#2F5D45",
      sortOrder: 6,
    },
  });

  const event = await prisma.event.upsert({
    where: { id: "evt_p5_duals" },
    update: {
      requiresCoachApproval: true,
      allowProposedChanges: true,
      responsibleCoachUserId: coach.id,
      approvalPaymentIntent: "PARENT_CHOOSES",
      cancellationPolicyText: "Entry fees are non-refundable inside 7 days.",
      paymentDueBy: ahead(18),
    },
    create: {
      id: "evt_p5_duals",
      clubId,
      type: "TOURNAMENT",
      name: "Fall Duals — Cedar Rapids",
      description: "Three-team duals. Coach picks the lineup.",
      startsAt: ahead(30),
      endsAt: ahead(30),
      capacity: 8,
      memberPrice: 100,
      nonMemberPrice: 125,
      isTournament: true,
      tournamentMode: "HOST",
      publicRegistration: true,
      publicSlug: "fall-duals-cedar-rapids",
      registrationDeadline: ahead(20),
      visibility: "PUBLIC",
      paymentMethods: ["CARD", "CASH", "CHECK"],
      registrationForm: [
        { id: "weightClass", label: "Weight class", type: "select", required: true, options: ["106", "113", "120", "126", "132"] },
        { id: "division", label: "Division", type: "select", required: true, options: ["14U", "16U", "Open"] },
      ],
      requiresCoachApproval: true,
      allowProposedChanges: true,
      responsibleCoachUserId: coach.id,
      approvalPaymentIntent: "PARENT_CHOOSES",
      cancellationPolicyText: "Entry fees are non-refundable inside 7 days.",
      paymentDueBy: ahead(18),
    },
  });

  // One registration per state the review screen has to render.
  const regs = [
    {
      id: "reg_p5_pending_invoice",
      memberId: athlete.id,
      name: "Cameron Hall",
      email: "parent@local.test",
      status: "PENDING_REVIEW",
      approvalStatus: "PENDING",
      paymentMethod: "INVOICE",
      amountDue: 100,
      confirmationCode: "P5CAM001",
      formResponses: { weightClass: "126", division: "16U" },
    },
    {
      id: "reg_p5_pending_cash",
      memberId: teammate.id,
      name: "Drayke Ulrich",
      email: "christina@local.test",
      status: "AWAITING_CASH",
      approvalStatus: "PENDING",
      paymentMethod: "CASH",
      amountDue: 100,
      confirmationCode: "P5DRA002",
      formResponses: { weightClass: "132", division: "16U" },
    },
    {
      id: "reg_p5_pending_public",
      memberId: null,
      name: "Milo Brehm",
      email: "milo.parent@local.test",
      status: "PENDING_REVIEW",
      approvalStatus: "PENDING",
      paymentMethod: "INVOICE",
      amountDue: 125,
      confirmationCode: "P5MIL003",
      formResponses: { weightClass: "120", division: "14U" },
    },
  ];
  for (const r of regs) {
    await prisma.eventRegistration.upsert({
      where: { id: r.id },
      update: {
        status: r.status,
        approvalStatus: r.approvalStatus,
        approvalRequestedAt: new Date(Date.now() - 3 * day),
        proposedChange: undefined,
        proposedChangeRespondedAt: null,
        proposedChangeAccepted: null,
      },
      create: {
        ...r,
        clubId,
        eventId: event.id,
        approvalRequestedAt: new Date(Date.now() - 3 * day),
      },
    });
  }

  // ── The 2026-08-12 bug shape ─────────────────────────────────────────────
  // A tournament priced for MEMBERS ONLY, shared cost off, charge-on-approval.
  // Before the fix a walk-in registered here for $0 and an approval collected
  // nothing while the family was emailed "this event is free".
  const memberPriced = await prisma.event.upsert({
    where: { id: "evt_p5_memberpriced" },
    update: {
      memberPrice: 1,
      nonMemberPrice: null,
      dropInFee: null,
      publicPricingOption: null,
      requiresCoachApproval: true,
      approvalPaymentIntent: "APPROVAL_CHARGE",
      responsibleCoachUserId: coach.id,
    },
    create: {
      id: "evt_p5_memberpriced",
      clubId,
      type: "TOURNAMENT",
      name: "Member-priced Duals ($1)",
      startsAt: ahead(25),
      endsAt: ahead(25),
      memberPrice: 1,
      isTournament: true,
      tournamentMode: "ATTEND",
      publicRegistration: true,
      publicSlug: "member-priced-duals",
      registrationDeadline: ahead(15),
      visibility: "PUBLIC",
      paymentMethods: ["CARD", "AUTO_CARD"],
      requiresCoachApproval: true,
      approvalPaymentIntent: "APPROVAL_CHARGE",
      responsibleCoachUserId: coach.id,
    },
  });

  // A registration in the exact state the bug produced: no payment method, no
  // amount, waiting on a coach. Approving it must now be REFUSED.
  await prisma.eventRegistration.upsert({
    where: { id: "reg_p5_nomethod" },
    update: { status: "PENDING_REVIEW", approvalStatus: "PENDING", paymentMethod: null, amountDue: null },
    create: {
      id: "reg_p5_nomethod",
      clubId,
      eventId: memberPriced.id,
      memberId: athlete.id,
      name: "Cameron Hall",
      email: "parent@local.test",
      status: "PENDING_REVIEW",
      approvalStatus: "PENDING",
      approvalRequestedAt: new Date(),
      paymentMethod: null,
      amountDue: null,
      confirmationCode: "P5NOM006",
      formResponses: {},
    },
  });

  console.log("Seeded Phase 5 fixtures:");
  console.log("  event      evt_p5_duals  (approval on, proposals on, coach = Reggie Okafor)");
  console.log("  type       cet_p5_dual   (policy set) · cet_p5_clinic (no policy)");
  console.log("  reviews    3 registrations awaiting the coach");
  console.log("  bug shape  evt_p5_memberpriced ($1 member price, no non-member price) + reg_p5_nomethod");
  console.log("  logins     owner@local.test · coach@local.test · parent@local.test / localtest123");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
