import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const SCOPE_TYPES = ["CLASS", "EVENT", "MEMBERSHIP", "PRIVATE_LESSON_TYPE"] as const;

const scopeSchema = z.object({
  scopeType: z.enum(SCOPE_TYPES),
  scopeId: z.string().min(1),
});

const planSchema = z.object({
  baseType: z.enum(["SALARY", "PER_CLASS", "HOURLY"]),
  baseAmount: z.number().min(0),
  baseScopes: z.array(scopeSchema).default([]), // CLASS scopes only are meaningful for base
  bonuses: z
    .array(
      z.object({
        bonusType: z.enum(["ATTENDANCE", "SIGNUP", "REVENUE_SHARE"]),
        amount: z.number().min(0),
        scopes: z.array(scopeSchema).default([]),
        minThreshold: z.number().int().min(0).nullable().optional(),
        maxThreshold: z.number().int().min(0).nullable().optional(),
      })
    )
    .default([]),
});

async function requireStaff(userId: string, clubId: string) {
  return prisma.user.findFirst({
    where: { id: userId, clubId, role: { in: ["OWNER", "STAFF"] }, deletedAt: null },
    select: { id: true },
  });
}

// GET /api/staff/[id]/compensation
// Returns the staff member's compensation plan plus the assignable options
// (classes / events / memberships / private lesson types) for the builder UI.
export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const staff = await requireStaff(id, session.user.clubId);
  if (!staff) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const [plan, classes, events, memberships, lessonTypes] = await Promise.all([
    prisma.staffCompensation.findUnique({
      where: { userId: id },
      include: { bonuses: true, assignments: true },
    }),
    prisma.recurringClass.findMany({
      where: { clubId: session.user.clubId, deletedAt: null },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.event.findMany({
      where: { clubId: session.user.clubId, deletedAt: null },
      select: { id: true, name: true, startsAt: true },
      orderBy: { startsAt: "desc" },
      take: 100,
    }),
    prisma.membership.findMany({
      where: { clubId: session.user.clubId, deletedAt: null },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.privateLessonType.findMany({
      where: { clubId: session.user.clubId, deletedAt: null },
      select: { id: true, title: true },
      orderBy: { title: "asc" },
    }),
  ]);

  // Reshape the plan: split assignments into base (bonusId null) vs per-bonus.
  const shaped = plan
    ? {
        baseType: plan.baseType,
        baseAmount: Number(plan.baseAmount),
        baseScopes: plan.assignments
          .filter((a) => a.bonusId === null)
          .map((a) => ({ scopeType: a.scopeType, scopeId: a.scopeId })),
        bonuses: plan.bonuses.map((bo) => ({
          id: bo.id,
          bonusType: bo.bonusType,
          amount: Number(bo.amount),
          minThreshold: bo.minThreshold,
          maxThreshold: bo.maxThreshold,
          scopes: plan.assignments
            .filter((a) => a.bonusId === bo.id)
            .map((a) => ({ scopeType: a.scopeType, scopeId: a.scopeId })),
        })),
      }
    : null;

  return NextResponse.json({
    plan: shaped,
    options: {
      classes,
      events: events.map((e) => ({ id: e.id, name: e.name })),
      memberships,
      lessonTypes: lessonTypes.map((l) => ({ id: l.id, name: l.title })),
    },
  });
}

// PUT /api/staff/[id]/compensation — replace the whole plan atomically.
export async function PUT(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const staff = await requireStaff(id, session.user.clubId);
  if (!staff) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let data: z.infer<typeof planSchema>;
  try {
    data = planSchema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  try {
    await prisma.$transaction(async (tx) => {
      // Cascade deletes wipe old bonuses + assignments; recreate from scratch.
      await tx.staffCompensation.deleteMany({ where: { userId: id } });

      const comp = await tx.staffCompensation.create({
        data: {
          clubId: session.user.clubId,
          userId: id,
          baseType: data.baseType,
          baseAmount: data.baseAmount,
        },
      });

      // Base-level assignments (bonusId stays null).
      if (data.baseScopes.length) {
        await tx.compensationAssignment.createMany({
          data: data.baseScopes.map((s) => ({
            compensationId: comp.id,
            bonusId: null,
            scopeType: s.scopeType,
            scopeId: s.scopeId,
          })),
        });
      }

      for (const b of data.bonuses) {
        // Normalize thresholds: 0 (or undefined) means "no bound".
        const minT = b.minThreshold && b.minThreshold > 0 ? b.minThreshold : null;
        const maxT = b.maxThreshold && b.maxThreshold > 0 ? b.maxThreshold : null;
        if (minT != null && maxT != null && minT >= maxT) {
          throw new Error("Bonus min threshold must be less than max threshold.");
        }
        const bonus = await tx.compensationBonus.create({
          data: {
            compensationId: comp.id,
            bonusType: b.bonusType,
            amount: b.amount,
            minThreshold: minT,
            maxThreshold: maxT,
          },
        });
        if (b.scopes.length) {
          await tx.compensationAssignment.createMany({
            data: b.scopes.map((s) => ({
              compensationId: comp.id,
              bonusId: bonus.id,
              scopeType: s.scopeType,
              scopeId: s.scopeId,
            })),
          });
        }
      }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Could not save compensation plan";
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}

// DELETE — clear the plan (staff falls back to no automated pay).
export async function DELETE(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  await prisma.staffCompensation.deleteMany({
    where: { userId: id, clubId: session.user.clubId },
  });
  return NextResponse.json({ ok: true });
}
