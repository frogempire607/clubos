import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { packageLessonTypeIds } from "@/lib/privateLessonRules";
import { requirePermission } from "@/lib/apiGuard";

const schema = z.object({
  title:            z.string().min(1).max(100).optional(),
  description:      z.string().max(500).optional().nullable(),
  lessonTypeId:     z.string().optional().nullable(),
  lessonTypeIds:    z.array(z.string()).optional(),
  credits:          z.number().int().positive().optional(),
  bonusCredits:     z.number().int().min(0).optional(),
  pricingMode:      z.enum(["FLAT", "PERCENT", "FIXED"]).optional(),
  discountValue:    z.number().nonnegative().nullable().optional(),
  price:            z.number().nonnegative().optional(),
  expiresAfterDays: z.number().int().positive().optional().nullable(),
  active:           z.boolean().optional(),
  // Owner toggle for the member-facing package shop. Patchable so the
  // owner can publish / unpublish without touching other fields.
  publishedToMembers: z.boolean().optional(),
});

async function requirePackage(id: string, clubId: string) {
  return prisma.privatePackage.findFirst({ where: { id, clubId, deletedAt: null } });
}

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  const guard = requirePermission(session, "events", "edit");
  if (guard) return guard;

  const pkg = await requirePackage(params.id, session!.user.clubId);
  if (!pkg) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const data = schema.parse(await req.json());
    const lessonTypeIds =
      data.lessonTypeIds !== undefined || data.lessonTypeId !== undefined
        ? packageLessonTypeIds(data.lessonTypeIds, data.lessonTypeId)
        : null;
    if (lessonTypeIds && lessonTypeIds.length) {
      const count = await prisma.privateLessonType.count({
        where: { clubId: session!.user.clubId, deletedAt: null, id: { in: lessonTypeIds } },
      });
      if (count !== lessonTypeIds.length) {
        return NextResponse.json({ error: "One or more lesson types were not found." }, { status: 400 });
      }
    }
    // Validate pricing model + discount value pair if either is being changed.
    const effectiveMode = data.pricingMode ?? pkg.pricingMode;
    const effectiveDiscount =
      data.discountValue !== undefined
        ? data.discountValue
        : pkg.discountValue !== null
          ? Number(pkg.discountValue)
          : null;
    if (effectiveMode !== "FLAT") {
      if (effectiveDiscount == null || effectiveDiscount <= 0) {
        return NextResponse.json({ error: "Enter a discount value for this pricing model." }, { status: 400 });
      }
      if (effectiveMode === "PERCENT" && effectiveDiscount > 100) {
        return NextResponse.json({ error: "Percentage discount must be between 0 and 100." }, { status: 400 });
      }
    }

    const updated = await prisma.privatePackage.update({
      where: { id: params.id },
      data: {
        ...data,
        ...(data.pricingMode === "FLAT" ? { discountValue: null } : {}),
        ...(lessonTypeIds
          ? {
              lessonTypeId: lessonTypeIds.length === 1 ? lessonTypeIds[0] : null,
              lessonTypeIds,
            }
          : {}),
      },
    });
    return NextResponse.json(updated);
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function DELETE(_req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  const guard = requirePermission(session, "events", "full");
  if (guard) return guard;

  const pkg = await requirePackage(params.id, session!.user.clubId);
  if (!pkg) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.privatePackage.update({ where: { id: params.id }, data: { deletedAt: new Date() } });
  return new NextResponse(null, { status: 204 });
}
