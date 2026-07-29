import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";

// PATCH /api/reports/costs/classification
// Body: { category, treatAs: "FIXED"|"VARIABLE" }
//
// Owner-only override that changes the fixed/variable classification for
// every expense in `category` that doesn't set `kind` on its own row.

const schema = z.object({
  category: z.string().min(1).max(80),
  treatAs: z.enum(["FIXED", "VARIABLE"]),
});

export async function PATCH(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Owner only" }, { status: 403 });
  }
  const denied = requirePermission(session, "finances", "full");
  if (denied) return denied;

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const { category, treatAs } = parsed.data;

  const upserted = await prisma.expenseClassificationOverride.upsert({
    where: {
      clubId_category: {
        clubId: session.user.clubId,
        category,
      },
    },
    create: {
      clubId: session.user.clubId,
      category,
      treatAs,
      updatedById: session.user.id,
    },
    update: {
      treatAs,
      updatedById: session.user.id,
    },
  });

  return NextResponse.json(upserted);
}

// DELETE /api/reports/costs/classification?category=…  — remove an override.
export async function DELETE(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Owner only" }, { status: 403 });
  }
  const denied = requirePermission(session, "finances", "full");
  if (denied) return denied;

  const url = new URL(req.url);
  const category = url.searchParams.get("category");
  if (!category) return NextResponse.json({ error: "category required" }, { status: 400 });

  await prisma.expenseClassificationOverride.deleteMany({
    where: { clubId: session.user.clubId, category },
  });
  return NextResponse.json({ ok: true });
}
