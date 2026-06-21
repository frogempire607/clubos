import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { findOrAutoLinkMember } from "@/lib/memberLink";

// POST /api/member/self-profile
//
// Lets a guardian/parent opt in to their OWN athlete profile so they can book
// classes or buy adult memberships/products for themselves and show up in the
// profile switcher — instead of existing only as hidden billing/contact data.
//
// Idempotent + safe:
//   1. If the user already has a member profile (own userId-linked Member), no-op.
//   2. Otherwise auto-link an unclaimed same-email ADULT member if one exists.
//   3. Otherwise create a fresh ADULT profile (status PROSPECT, no membership,
//      no billing). Never touches Stripe or member counts/limits.
//
// Honors the members_userId global-unique invariant: any soft-deleted member
// still holding this userId is released first so the create/link can't 500.
export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "MEMBER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, clubId: true, email: true, firstName: true, lastName: true },
  });
  if (!user) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // 1) Already has an own profile?
  const existing = await prisma.member.findFirst({
    where: { userId: user.id, clubId: user.clubId, deletedAt: null },
    select: { id: true },
  });
  if (existing) return NextResponse.json({ ok: true, memberId: existing.id, created: false });

  // 2) Link an unclaimed same-email adult member if present.
  const linked = await findOrAutoLinkMember(user.id, user.clubId, user.email);
  if (linked) return NextResponse.json({ ok: true, memberId: linked.id, created: false });

  // 3) Release any soft-deleted member still reserving this userId, then create.
  await prisma.member.updateMany({
    where: { userId: user.id, deletedAt: { not: null } },
    data: { userId: null },
  });

  const created = await prisma.member.create({
    data: {
      clubId: user.clubId,
      userId: user.id,
      firstName: user.firstName || "Member",
      lastName: user.lastName || "",
      email: user.email.toLowerCase(),
      isMinor: false,
      // status defaults to PROSPECT — no membership/billing is created here.
      leadSource: "PARENT_SELF",
    },
    select: { id: true },
  });

  return NextResponse.json({ ok: true, memberId: created.id, created: true });
}
