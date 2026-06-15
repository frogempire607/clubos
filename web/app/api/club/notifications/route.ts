import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const schema = z.object({
  newMemberJoins: z.boolean().optional(),
  paymentFailed: z.boolean().optional(),
  dailySummary: z.boolean().optional(),
  newBooking: z.boolean().optional(),
  memberInactive: z.boolean().optional(),
});

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const club = await prisma.club.findUnique({
    where: { id: session.user.clubId },
    select: { notificationPrefs: true },
  });

  return NextResponse.json(club?.notificationPrefs || {});
}

export async function PATCH(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const data = schema.parse(await req.json());
    const club = await prisma.club.findUnique({
      where: { id: session.user.clubId },
      select: { notificationPrefs: true },
    });
    const current = (club?.notificationPrefs as Record<string, boolean>) || {};
    const updated = { ...current, ...data };

    await prisma.club.update({
      where: { id: session.user.clubId },
      data: { notificationPrefs: updated },
    });
    return NextResponse.json(updated);
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors }, { status: 400 });
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
