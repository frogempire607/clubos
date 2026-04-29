import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
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
  creditsGranted: z.number().int().positive(),
  expiresAfterDays: z.number().int().positive().optional().nullable(),
  notes: z.string().optional(),
  lessonTypeId: z.string().optional().nullable(),
});

export async function POST(req: Request, { params }: { params: { id: string } }) {
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
    const expiresAt = data.expiresAfterDays
      ? new Date(Date.now() + data.expiresAfterDays * 86400000)
      : null;

    const entry = await prisma.privateCreditLedger.create({
      data: {
        clubId: session.user.clubId,
        memberId: params.id,
        lessonTypeId: data.lessonTypeId || null,
        creditsGranted: data.creditsGranted,
        purchaseType: "MANUAL",
        expiresAt,
        notes: data.notes || null,
        adjustedById: session.user.id,
      },
    });
    return NextResponse.json(entry, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
