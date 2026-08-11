import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { groupDuplicates, duplicateReasonLabel } from "@/lib/memberDuplicates";

// GET /api/members/duplicates
//
// READ-ONLY. Surfaces likely-duplicate members so an owner/staff can review and
// (separately, with explicit confirmation) merge them. It NEVER merges or
// changes anything here.
//
// Matching is high-precision on purpose — false positives scare owners. Members
// are clustered only when they share a STRONG signal:
//   • same email (a real person, not a shared guardian email)
//   • same first+last name AND same date of birth
//   • same phone AND same last name
//
// ── Guardian contact is NEVER a duplicate signal (session 4, D-1) ───────────
// This comment used to claim siblings were safe because "minors carry the
// guardian's email on guardianEmail, not their own email". That is the rule,
// but it was not the data: measured read-only against production, 27 of the 34
// live minors with an own email carried their GUARDIAN's, and 42 carried the
// guardian's phone. The importer copied generic email/phone columns onto the
// child. So siblings collided on `email:`, and on `phone:`+lastName (siblings
// share a surname) — the detector was keying on guardian contact after all,
// just laundered through the wrong column.
//
// `keysOf` now drops an email/phone key whenever that value equals the SAME
// ROW's guardianEmail/guardianPhone. A shared address is evidence of a shared
// guardian, never of a shared person. This is deliberately independent of the
// data-correction script: cleaning the rows is not enough, because the next
// import can reintroduce the same shape. Both halves are required.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const guard = requirePermission(session, "members", "view");
  if (guard) return guard;
  const clubId = (session.user as { clubId?: string }).clubId as string;

  const members = await prisma.member.findMany({
    where: { clubId, deletedAt: null },
    select: {
      id: true, firstName: true, lastName: true, dateOfBirth: true,
      email: true, phone: true, guardianEmail: true, guardianName: true,
      guardianPhone: true, guardianRelationship: true,
      streetAddress: true, city: true, state: true, zipCode: true, gender: true,
      isMinor: true, status: true, userId: true, migrationStatus: true, createdAt: true,
      _count: { select: { subscriptions: true, attendanceRecords: true, bookings: true, transactions: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  type M = (typeof members)[number];

  const groups0 = groupDuplicates(members);

  // Higher score = better "keep" candidate (has a login, completed onboarding,
  // carries the most real data).
  const score = (m: M) =>
    (m.userId ? 100000 : 0) +
    (m.migrationStatus === "COMPLETED" ? 50000 : 0) +
    m._count.subscriptions * 500 +
    m._count.attendanceRecords * 5 +
    m._count.bookings * 5 +
    m._count.transactions * 20;

  const groups = groups0
    .map((g) => {
      const sorted = [...g.members].sort((a, b) => score(b) - score(a));
      const primary = sorted[0];
      return {
        reason: duplicateReasonLabel(g.reasons),
        suggestedPrimaryId: primary.id,
        members: sorted.map((m) => ({
          id: m.id,
          name: `${m.firstName} ${m.lastName}`.trim(),
          firstName: m.firstName,
          lastName: m.lastName,
          email: m.email,
          phone: m.phone,
          guardianEmail: m.guardianEmail,
          guardianName: m.guardianName,
          guardianPhone: m.guardianPhone,
          guardianRelationship: m.guardianRelationship,
          streetAddress: m.streetAddress,
          city: m.city,
          state: m.state,
          zipCode: m.zipCode,
          gender: m.gender,
          dateOfBirth: m.dateOfBirth,
          isMinor: m.isMinor,
          status: m.status,
          hasLogin: !!m.userId,
          migrationStatus: m.migrationStatus,
          createdAt: m.createdAt,
          counts: {
            memberships: m._count.subscriptions,
            attendance: m._count.attendanceRecords,
            bookings: m._count.bookings,
            payments: m._count.transactions,
          },
        })),
      };
    })
    .sort((a, b) => b.members.length - a.members.length);

  return NextResponse.json({ groupCount: groups.length, groups });
}
