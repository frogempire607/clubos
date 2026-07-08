import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";

// GET /api/members/duplicates
//
// READ-ONLY. Surfaces likely-duplicate members so an owner/staff can review and
// (separately, with explicit confirmation) merge them. It NEVER merges or
// changes anything here.
//
// Matching is high-precision on purpose — false positives scare owners. Members
// are clustered only when they share a STRONG signal:
//   • same email (a real person, not a shared guardian email — minors carry the
//     guardian's email on guardianEmail, not their own email)
//   • same first+last name AND same date of birth
//   • same phone AND same last name
// Siblings (same guardianEmail, different name/DOB) share none of these, so they
// are never flagged as duplicates.
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

  const norm = (s: string | null) => (s ? s.trim().toLowerCase() : "");
  const dobKey = (d: Date | null) => (d ? new Date(d).toISOString().slice(0, 10) : "");
  const keysOf = (m: M): string[] => {
    const keys: string[] = [];
    const email = norm(m.email);
    if (email) keys.push("email:" + email);
    const first = norm(m.firstName);
    const last = norm(m.lastName);
    const dk = dobKey(m.dateOfBirth);
    if (first && last && dk) keys.push("namedob:" + first + "|" + last + "|" + dk);
    const phone = (m.phone || "").replace(/\D/g, "");
    if (phone.length >= 10 && last) keys.push("phone:" + phone + "|" + last);
    return keys;
  };

  // Union-find: merge any two members that share a strong key.
  const parent = new Map<string, string>();
  for (const m of members) parent.set(m.id, m.id);
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) && parent.get(r) !== r) r = parent.get(r) as string;
    return r;
  };
  const union = (a: string, b: string) => { parent.set(find(a), find(b)); };

  const keyToMember = new Map<string, string>();
  for (const m of members) {
    for (const k of keysOf(m)) {
      const prev = keyToMember.get(k);
      if (prev) union(prev, m.id);
      else keyToMember.set(k, m.id);
    }
  }

  const byRoot = new Map<string, M[]>();
  const reasonByRoot = new Map<string, Set<string>>();
  for (const m of members) {
    const root = find(m.id);
    if (!byRoot.has(root)) { byRoot.set(root, []); reasonByRoot.set(root, new Set()); }
    byRoot.get(root)!.push(m);
    for (const k of keysOf(m)) reasonByRoot.get(root)!.add(k.split(":")[0]);
  }

  // Higher score = better "keep" candidate (has a login, completed onboarding,
  // carries the most real data).
  const score = (m: M) =>
    (m.userId ? 100000 : 0) +
    (m.migrationStatus === "COMPLETED" ? 50000 : 0) +
    m._count.subscriptions * 500 +
    m._count.attendanceRecords * 5 +
    m._count.bookings * 5 +
    m._count.transactions * 20;

  const reasonLabel = (prefixes: Set<string> | undefined): string => {
    const parts: string[] = [];
    if (prefixes?.has("email")) parts.push("same email");
    if (prefixes?.has("namedob")) parts.push("same name & date of birth");
    if (prefixes?.has("phone")) parts.push("same phone & last name");
    return parts.join(" · ") || "possible duplicate";
  };

  const groups = [...byRoot.entries()]
    .filter(([, g]) => g.length > 1)
    .map(([root, g]) => {
      const sorted = [...g].sort((a, b) => score(b) - score(a));
      const primary = sorted[0];
      return {
        reason: reasonLabel(reasonByRoot.get(root)),
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
