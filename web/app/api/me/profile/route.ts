import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// PATCH /api/me/profile — every dashboard user can update their own name.
// Email/role/clubId are intentionally NOT editable here (changing those
// requires owner action). This endpoint is what powers /dashboard/my-account.
const schema = z.object({
  firstName: z.string().min(1).max(60),
  lastName:  z.string().min(1).max(60),
});

export async function PATCH(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const data = schema.parse(await req.json());
    await prisma.user.update({
      where: { id: session.user.id },
      data: { firstName: data.firstName, lastName: data.lastName },
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors[0]?.message ?? "Invalid input" }, { status: 400 });
    }
    return NextResponse.json({ error: "Save failed" }, { status: 500 });
  }
}
