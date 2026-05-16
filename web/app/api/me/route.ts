import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolvePermissions } from "@/lib/permissions";

// GET /api/me — current user's role + LIVE resolved permissions.
// The dashboard nav uses this so a permissions change by the owner is
// reflected without forcing the staff member to re-login.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const role = (session.user as any).role as string;

  if (role !== "STAFF") {
    // Owners (and anyone else) — no permission restrictions to report.
    return NextResponse.json({ role, permissions: null });
  }

  const profile = await prisma.staffProfile.findUnique({
    where: { userId: (session.user as any).id },
    select: { permissions: true, title: true },
  });

  return NextResponse.json({
    role,
    title: profile?.title ?? null,
    permissions: resolvePermissions(profile?.permissions ?? null),
  });
}
