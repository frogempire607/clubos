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

  const norm = (s: string | null) => (s ? s.trim().toLowerCase() : "");
  const dobKey = (d: Date | null) => (d ? new Date(d).toISOString().slice(0, 10) : "");
  const digits = (s: string | null) => (s || "").replace(/\D/g, "");
  const keysOf = (m: M): string[] => {
    const keys: string[] = [];

    // A value that also appears in this row's own guardian columns is the
    // guardian's, whichever column it is sitting in. It groups siblings, so it
    // must never become a key. See the header note.
    const email = norm(m.email);
    if (email && email !== norm(m.guardianEmail)) keys.push("email:" + email);

    const first = norm(m.firstName);
    const last = norm(m.lastName);
    const dk = dobKey(m.dateOfBirth);
    if (first && last && dk) keys.push("namedob:" + first + "|" + last + "|" + dk);

    const phone = digits(m.phone);
    if (phone.length >= 10 && last && phone !== digits(m.guardianPhone)) {
      keys.push("phone:" + phone + "|" + last);
    }
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

  // Record only the keys that ACTUALLY caused a union. The previous version
  // collected every key prefix held by every member of a group, so a group
  // formed purely on email still told the owner "same name & date of birth" —
  // each member had a namedob key of their own, it just never collided. Stating
  // evidence that does not exist is how an owner learns to distrust the screen.
  const keyToMember = new Map<string, string>();
  const collisions: { prefix: string; a: string }[] = [];
  for (const m of members) {
    for (const k of keysOf(m)) {
      const prev = keyToMember.get(k);
      if (prev) { union(prev, m.id); collisions.push({ prefix: k.split(":")[0], a: m.id }); }
      else keyToMember.set(k, m.id);
    }
  }

  const byRoot = new Map<string, M[]>();
  const reasonByRoot = new Map<string, Set<string>>();
  for (const m of members) {
    const root = find(m.id);
    if (!byRoot.has(root)) { byRoot.set(root, []); reasonByRoot.set(root, new Set()); }
    byRoot.get(root)!.push(m);
  }
  // Roots are only final after every union, so attribute collisions afterwards.
  for (const c of collisions) {
    const root = find(c.a);
    if (!reasonByRoot.has(root)) reasonByRoot.set(root, new Set());
    reasonByRoot.get(root)!.add(c.prefix);
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
