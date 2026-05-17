import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requirePermission } from "@/lib/apiGuard";
import { sendActivation } from "@/lib/migrationServer";

// POST /api/members/migration/[id]/resend — resend the activation link to one
// member (always treated as a reminder for audit-log clarity).
export async function POST(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "members", "edit");
  if (denied) return denied;

  const r = await sendActivation(id, session.user.clubId, session.user.id, true);
  if (!r.ok) return NextResponse.json({ error: r.reason || "Could not send" }, { status: 400 });
  return NextResponse.json({ ok: true });
}

// GET /api/members/migration/[id]/resend — migration history for one member
// (used by the dashboard "reminder history" drawer).
export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "members", "view");
  if (denied) return denied;

  const { prisma } = await import("@/lib/prisma");
  const events = await prisma.memberMigrationEvent.findMany({
    where: { memberId: id, clubId: session.user.clubId },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return NextResponse.json({ events });
}
