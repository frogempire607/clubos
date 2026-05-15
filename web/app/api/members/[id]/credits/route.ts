import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const member = await prisma.member.findFirst({
    where: { id: params.id, clubId: session.user.clubId, deletedAt: null },
  });
  if (!member) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const ledger = await prisma.privateCreditLedger.findMany({
    where: { memberId: params.id, clubId: session.user.clubId },
    include: { package: { select: { title: true } } },
    orderBy: { createdAt: "desc" },
  });

  const totalRemaining = ledger
    .filter((l) => l.status === "active")
    .reduce((sum, l) => sum + (l.creditsGranted - l.creditsUsed), 0);

  return NextResponse.json({ ledger, totalRemaining });
}

const adjustSchema = z.object({
  creditsGranted: z.number().int().positive().optional(),
  packageId: z.string().optional().nullable(),
  expiresAfterDays: z.number().int().positive().optional().nullable(),
  notes: z.string().optional(),
  lessonTypeId: z.string().optional().nullable(),
});

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const member = await prisma.member.findFirst({
    where: { id: params.id, clubId: session.user.clubId, deletedAt: null },
  });
  if (!member) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const data = adjustSchema.parse(await req.json());
    const pkg = data.packageId
      ? await prisma.privatePackage.findFirst({
          where: { id: data.packageId, clubId: session.user.clubId, deletedAt: null, active: true },
        })
      : null;

    if (data.packageId && !pkg) {
      return NextResponse.json({ error: "Package not found" }, { status: 404 });
    }

    const lessonsGranted = pkg ? pkg.credits + pkg.bonusCredits : data.creditsGranted;
    if (!lessonsGranted) {
      return NextResponse.json({ error: "Lesson quantity is required." }, { status: 400 });
    }

    const expiresAfterDays = data.expiresAfterDays ?? pkg?.expiresAfterDays ?? null;
    const expiresAt = expiresAfterDays
      ? new Date(Date.now() + expiresAfterDays * 86400000)
      : null;

    const entry = await prisma.privateCreditLedger.create({
      data: {
        clubId: session.user.clubId,
        memberId: params.id,
        packageId: pkg?.id ?? null,
        lessonTypeId: pkg?.lessonTypeId ?? data.lessonTypeId ?? null,
        creditsGranted: lessonsGranted,
        purchaseType: pkg ? "PACKAGE" : "MANUAL",
        expiresAt,
        pricePaid: pkg?.price ?? null,
        notes: data.notes || (pkg ? `Package purchase: ${pkg.title}` : null),
        adjustedById: session.user.id,
      },
    });
    return NextResponse.json(entry, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
