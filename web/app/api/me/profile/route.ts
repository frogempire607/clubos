import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { recordStaffActivity, actorFrom } from "@/lib/staffActivity";

// PATCH /api/me/profile — every dashboard user can update their own name.
// Email/role/clubId are intentionally NOT editable here (changing those
// requires owner action). This endpoint is what powers /dashboard/my-account.
const schema = z.object({
  firstName: z.string().min(1).max(60),
  lastName:  z.string().min(1).max(60),
  // B21: staff keep a private phone on their own profile (never shown to members).
  phone:     z.string().max(50).nullable().optional(),
});

export async function PATCH(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const data = schema.parse(await req.json());
    const before = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { firstName: true, lastName: true, staffProfile: { select: { phone: true } } },
    });
    await prisma.user.update({
      where: { id: session.user.id },
      data: { firstName: data.firstName, lastName: data.lastName },
    });
    if (session.user.role === "STAFF" && data.phone !== undefined) {
      await prisma.staffProfile.upsert({
        where: { userId: session.user.id },
        update: { phone: data.phone },
        create: { userId: session.user.id, phone: data.phone },
      });
    }
    if (session.user.role === "STAFF" && before) {
      const changed: string[] = [];
      if (before.firstName !== data.firstName) changed.push("first name");
      if (before.lastName !== data.lastName) changed.push("last name");
      if (data.phone !== undefined && (data.phone ?? null) !== (before.staffProfile?.phone ?? null)) changed.push("phone");
      if (changed.length) {
        await recordStaffActivity({
          clubId: session.user.clubId,
          staffUserId: session.user.id,
          ...actorFrom(session),
          kind: "PERSONAL",
          summary: `Updated ${changed.join(", ")} from their own profile`,
        });
      }
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors[0]?.message ?? "Invalid input" }, { status: 400 });
    }
    return NextResponse.json({ error: "Save failed" }, { status: 500 });
  }
}
