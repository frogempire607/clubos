import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveFamilyContext } from "@/lib/memberContext";

// GET /api/member/context
// The set of profiles the signed-in portal user can act on: their own member
// profile (if any) plus every child they guardian. Powers the family / profile
// switcher on the purchase surfaces so a guardian can pick which athlete a
// purchase is for. hasMemberProfile is TRUE when the user can act on ANY
// profile (own or child) — so a guardian with no membership of their own is no
// longer blocked.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "MEMBER") {
    // Owner/staff previewing the portal have no member context.
    return NextResponse.json({ accessible: [], hasMemberProfile: false, isGuardian: false });
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { email: true },
  });
  if (!user) return NextResponse.json({ accessible: [], hasMemberProfile: false, isGuardian: false });

  const resolved = await resolveFamilyContext(session.user.id, session.user.clubId, user.email);
  if (resolved === "FORBIDDEN") {
    return NextResponse.json({ accessible: [], hasMemberProfile: false, isGuardian: false });
  }

  const hasSelf = resolved.accessible.some((m) => m.kind === "self");
  const childCount = resolved.accessible.filter((m) => m.kind === "child").length;

  return NextResponse.json({
    accessible: resolved.accessible,
    hasMemberProfile: resolved.accessible.length > 0,
    // A guardian (manages children, no own membership) vs a normal member.
    isGuardian: !hasSelf && childCount > 0,
    defaultMemberId: resolved.context?.id ?? null,
  });
}
