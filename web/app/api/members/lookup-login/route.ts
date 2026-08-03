// Does a portal login already exist for this email in my club?
//
// Powers the Phase 4B.8 warning on the member form: when an athlete's OWN email
// is really the parent's address, the guardian-link paths (which match on
// Member.guardianEmail) never fire and the family silently fails to link. This
// lets the form say so before the record is saved wrong.
//
// Deliberately minimal: returns a display name and the email that was already
// supplied by the caller. It never enumerates accounts — an exact-match lookup
// only, and staff-gated.

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "members", "edit");
  if (denied) return denied;

  const email = (new URL(req.url).searchParams.get("email") || "").trim().toLowerCase();
  if (!email) return NextResponse.json({ user: null });

  const user = await prisma.user.findFirst({
    where: { clubId: session.user.clubId, email, deletedAt: null },
    select: {
      id: true, email: true, firstName: true, lastName: true, role: true,
      memberProfile: { select: { id: true } },
    },
  });
  if (!user) return NextResponse.json({ user: null });

  return NextResponse.json({
    user: {
      userId: user.id,
      email: user.email,
      name: `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || user.email,
      role: user.role,
      ownMemberId: user.memberProfile?.id ?? null,
    },
  });
}
