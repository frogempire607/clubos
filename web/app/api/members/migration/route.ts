import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { MIGRATION_STATUS, PAYMENT_SETUP } from "@/lib/migration";
import type { Prisma } from "@prisma/client";

// GET /api/members/migration?filter=&page=&pageSize=&q=
// Migration dashboard: bucket counts + a paginated, filtered member list.
// NOT tier-gated. Permission-gated on `members` view like the rest of the app.
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "members", "view");
  if (denied) return denied;

  const clubId = session.user.clubId;
  const url = new URL(req.url);
  const filter = url.searchParams.get("filter") || "all";
  const q = (url.searchParams.get("q") || "").trim();
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const pageSize = Math.min(100, Math.max(10, parseInt(url.searchParams.get("pageSize") || "25", 10)));

  // Only members that went through migration (migrationStatus set).
  const base: Prisma.MemberWhereInput = {
    clubId,
    deletedAt: null,
    migrationStatus: { not: null },
  };

  const filterWhere: Prisma.MemberWhereInput =
    filter === "imported"
      ? { migrationStatus: MIGRATION_STATUS.IMPORTED }
      : filter === "invited"
        ? { migrationStatus: MIGRATION_STATUS.INVITED }
        : filter === "activated"
          ? { migrationStatus: MIGRATION_STATUS.ACTIVATED }
          : filter === "completed"
            ? { migrationStatus: MIGRATION_STATUS.COMPLETED }
            : filter === "needs_review"
              ? { migrationStatus: { in: [MIGRATION_STATUS.NEEDS_REVIEW, MIGRATION_STATUS.FAILED] } }
              : filter === "payment_required"
                ? {
                    paymentSetupStatus: PAYMENT_SETUP.REQUIRED,
                    migrationStatus: { not: MIGRATION_STATUS.COMPLETED },
                  }
                : {};

  const search: Prisma.MemberWhereInput = q
    ? {
        OR: [
          { firstName: { contains: q, mode: "insensitive" } },
          { lastName: { contains: q, mode: "insensitive" } },
          { email: { contains: q, mode: "insensitive" } },
          { guardianEmail: { contains: q, mode: "insensitive" } },
          { legacyMemberId: { contains: q, mode: "insensitive" } },
        ],
      }
    : {};

  const where: Prisma.MemberWhereInput = { AND: [base, filterWhere, search] };

  const [
    total,
    imported,
    invited,
    activated,
    completed,
    needsReview,
    paymentRequired,
    missingContact,
    emailsSentAgg,
    rows,
    pageCount,
  ] = await Promise.all([
    prisma.member.count({ where: base }),
    prisma.member.count({ where: { ...base, migrationStatus: MIGRATION_STATUS.IMPORTED } }),
    prisma.member.count({ where: { ...base, migrationStatus: MIGRATION_STATUS.INVITED } }),
    prisma.member.count({ where: { ...base, migrationStatus: MIGRATION_STATUS.ACTIVATED } }),
    prisma.member.count({ where: { ...base, migrationStatus: MIGRATION_STATUS.COMPLETED } }),
    prisma.member.count({
      where: { ...base, migrationStatus: { in: [MIGRATION_STATUS.NEEDS_REVIEW, MIGRATION_STATUS.FAILED] } },
    }),
    prisma.member.count({
      where: { ...base, paymentSetupStatus: PAYMENT_SETUP.REQUIRED, migrationStatus: { not: MIGRATION_STATUS.COMPLETED } },
    }),
    prisma.member.count({
      where: { ...base, email: null, guardianEmail: null },
    }),
    prisma.member.aggregate({ where: base, _sum: { activationEmailSendCount: true } }),
    prisma.member.findMany({
      where,
      orderBy: { importedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        isMinor: true,
        guardianName: true,
        guardianEmail: true,
        legacySource: true,
        legacyMembershipName: true,
        legacyMembershipPrice: true,
        legacyBillingFrequency: true,
        billingAnchorDate: true,
        commitmentEndDate: true,
        migrationStatus: true,
        paymentSetupStatus: true,
        activationEmailSentAt: true,
        activationEmailSendCount: true,
        activatedAt: true,
        migrationCompletedAt: true,
        importedAt: true,
      },
    }),
    prisma.member.count({ where }),
  ]);

  return NextResponse.json({
    stats: {
      total,
      imported,
      invited,
      activated,
      completed,
      needsReview,
      paymentRequired,
      missingContact,
      activationEmailsSent: emailsSentAgg._sum.activationEmailSendCount ?? 0,
    },
    members: rows,
    page,
    pageSize,
    pageCount: Math.ceil(pageCount / pageSize),
    totalInFilter: pageCount,
  });
}
