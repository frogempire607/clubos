import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { EXCLUDE_VOID } from "@/lib/paymentSources";

// GET /api/dashboard/summary
// Club-scoped owner/staff metrics for the customizable dashboard widgets.
// NOT tier-gated — cash tracking and basic counts are available on every plan.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const clubId = session.user.clubId;

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayEnd = new Date(todayStart.getTime() + 86400000);
  const in14Days = new Date(todayStart.getTime() + 14 * 86400000);

  const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000);

  const [
    totalMembers,
    activeMembers,
    newMembers,
    revenueAgg,
    expenseAgg,
    failedPayments,
    attendanceMonth,
    unreadMessages,
    pendingRegs,
    requiredDocs,
    upcomingEventsCount,
    todayEventsCount,
    upcomingClasses,
    club,
    membershipCount,
    eventCount,
    recentMessagesRaw,
    pendingBookingsRaw,
  ] = await Promise.all([
    prisma.member.count({ where: { clubId, deletedAt: null } }),
    prisma.member.count({ where: { clubId, deletedAt: null, status: "ACTIVE" } }),
    prisma.member.count({ where: { clubId, deletedAt: null, joinedAt: { gte: monthStart } } }),
    prisma.transaction.aggregate({
      // Voided rows (e.g. reclassified external-reader records) never count.
      where: { clubId, status: "SUCCEEDED", ...EXCLUDE_VOID, createdAt: { gte: monthStart } },
      _sum: { amount: true },
    }),
    prisma.expense.aggregate({
      where: { clubId, date: { gte: monthStart } },
      _sum: { amount: true },
    }),
    prisma.transaction.count({
      where: { clubId, status: "FAILED", createdAt: { gte: monthStart } },
    }),
    prisma.attendanceRecord.count({
      where: { clubId, createdAt: { gte: monthStart } },
    }),
    prisma.message.count({
      where: { clubId, recipientId: session.user.id, readAt: null },
    }),
    prisma.eventRegistration.findMany({
      where: { clubId, status: { notIn: ["PAID", "CANCELED"] }, amountDue: { not: null } },
      select: { amountDue: true },
    }),
    prisma.document.findMany({
      where: {
        clubId,
        deletedAt: null,
        required: true,
        OR: [{ publishAt: null }, { publishAt: { lte: now } }],
      },
      select: { id: true, _count: { select: { signatures: true } } },
    }),
    prisma.event.count({
      where: { clubId, deletedAt: null, startsAt: { gte: now } },
    }),
    prisma.event.count({
      where: { clubId, deletedAt: null, startsAt: { gte: todayStart, lt: todayEnd } },
    }),
    prisma.classSession.findMany({
      where: { clubId, canceled: false, startsAt: { gte: now, lt: in14Days } },
      orderBy: { startsAt: "asc" },
      take: 5,
      include: { recurringClass: { select: { name: true } } },
    }),
    prisma.club.findUnique({
      where: { id: clubId },
      select: { stripeChargesEnabled: true, logoUrl: true, primaryColor: true },
    }),
    prisma.membership.count({ where: { clubId } }),
    prisma.event.count({ where: { clubId, deletedAt: null } }),
    // Recent direct messages sent to this owner/staff user — last 5,
    // newest first. Includes the sender's name so the widget can render
    // without an extra fetch.
    prisma.message.findMany({
      where: { clubId, recipientId: session.user.id },
      orderBy: { createdAt: "desc" },
      take: 5,
      include: { sender: { select: { id: true, firstName: true, lastName: true, role: true } } },
    }),
    // Recent bookings — last 7 days, newest first. Booking has no
    // direct clubId column, so we scope through the event relation.
    prisma.booking.findMany({
      where: { event: { clubId }, createdAt: { gte: sevenDaysAgo } },
      orderBy: { createdAt: "desc" },
      take: 5,
      include: {
        event: { select: { id: true, name: true, startsAt: true } },
        member: { select: { id: true, firstName: true, lastName: true } },
      },
    }),
  ]);

  const revenue = Number(revenueAgg._sum.amount ?? 0);
  const expenses = Number(expenseAgg._sum.amount ?? 0);

  const pendingPaymentsCount = pendingRegs.length;
  const pendingPaymentsTotal = pendingRegs.reduce(
    (s, r) => s + (r.amountDue ? Number(r.amountDue) : 0),
    0,
  );

  // Approximate outstanding required signatures across active members.
  const signaturesHave = requiredDocs.reduce((s, d) => s + d._count.signatures, 0);
  const docsNeedingSignatures = Math.max(
    0,
    requiredDocs.length * activeMembers - signaturesHave,
  );

  // Setup / migration progress checklist.
  const setupItems = [
    { key: "members", label: "Add members", done: totalMembers > 0 },
    { key: "memberships", label: "Create a membership", done: membershipCount > 0 },
    { key: "events", label: "Schedule an event or class", done: eventCount > 0 },
    { key: "branding", label: "Add your club logo", done: !!club?.logoUrl },
    { key: "payments", label: "Connect Stripe", done: !!club?.stripeChargesEnabled },
    { key: "documents", label: "Add required documents", done: requiredDocs.length > 0 },
  ];
  const setupDone = setupItems.filter((i) => i.done).length;

  return NextResponse.json({
    activeMembers,
    totalMembers,
    newMembers,
    revenueMonth: revenue,
    netIncome: revenue - expenses,
    expensesMonth: expenses,
    attendanceMonth,
    failedPayments,
    unreadMessages,
    pendingPayments: { count: pendingPaymentsCount, total: pendingPaymentsTotal },
    docsNeedingSignatures,
    upcomingEvents: upcomingEventsCount,
    todayEvents: todayEventsCount,
    upcomingClasses: upcomingClasses.map((s) => ({
      id: s.id,
      name: s.recurringClass?.name ?? "Class",
      startsAt: s.startsAt,
    })),
    recentMessages: recentMessagesRaw.map((m) => ({
      id: m.id,
      body: m.body,
      createdAt: m.createdAt,
      readAt: m.readAt,
      sender: {
        id: m.sender.id,
        firstName: m.sender.firstName,
        lastName: m.sender.lastName,
        role: m.sender.role,
      },
    })),
    pendingBookings: pendingBookingsRaw.map((b) => ({
      id: b.id,
      status: b.status,
      createdAt: b.createdAt,
      member: b.member ? { id: b.member.id, firstName: b.member.firstName, lastName: b.member.lastName } : null,
      event: b.event ? { id: b.event.id, name: b.event.name, startsAt: b.event.startsAt } : null,
    })),
    setup: { items: setupItems, done: setupDone, total: setupItems.length },
  });
}
