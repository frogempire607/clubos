import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";

const schema = z.object({ userId: z.string().min(1) });

async function loadClass(id: string, clubId: string) {
  const cls = await prisma.recurringClass.findFirst({
    where: { id, clubId, deletedAt: null },
    select: { id: true, assignedStaffIds: true },
  });
  if (!cls) return null;
  return {
    id: cls.id,
    staffIds: Array.isArray(cls.assignedStaffIds) ? (cls.assignedStaffIds as string[]) : [],
  };
}

// POST /api/classes/[id]/staff  { userId }  — add staff to a recurring class
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "classes", "edit");
  if (denied) return denied;

  let userId: string;
  try {
    userId = schema.parse(await req.json()).userId;
  } catch {
    return NextResponse.json({ error: "userId required" }, { status: 400 });
  }

  const cls = await loadClass(id, session.user.clubId);
  if (!cls) return NextResponse.json({ error: "Class not found" }, { status: 404 });

  const staff = await prisma.user.findFirst({
    where: { id: userId, clubId: session.user.clubId, role: { in: ["OWNER", "STAFF"] }, deletedAt: null },
    select: { id: true },
  });
  if (!staff) return NextResponse.json({ error: "Staff member not found" }, { status: 404 });

  if (!cls.staffIds.includes(userId)) {
    await prisma.recurringClass.update({
      where: { id: cls.id },
      data: { assignedStaffIds: [...cls.staffIds, userId] },
    });
  }
  return NextResponse.json({ ok: true });
}

// DELETE /api/classes/[id]/staff?userId=...  — remove staff from a recurring class
export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "classes", "edit");
  if (denied) return denied;

  const userId = new URL(req.url).searchParams.get("userId");
  if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });

  const cls = await loadClass(id, session.user.clubId);
  if (!cls) return NextResponse.json({ error: "Class not found" }, { status: 404 });

  await prisma.recurringClass.update({
    where: { id: cls.id },
    data: { assignedStaffIds: cls.staffIds.filter((x) => x !== userId) },
  });
  return NextResponse.json({ ok: true });
}
