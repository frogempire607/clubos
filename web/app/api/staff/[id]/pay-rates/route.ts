import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requirePermission } from "@/lib/apiGuard";
import { prisma } from "@/lib/prisma";

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "finances", "view");
  if (denied) return denied;

  const rates = await prisma.privateLessonPayRate.findMany({
    where: { userId: params.id, clubId: session.user.clubId },
    include: { lessonType: { select: { title: true } } },
  });

  return NextResponse.json(rates);
}

const schema = z.object({
  lessonTypeId: z.string(),
  payType:      z.enum(["FLAT", "PERCENT"]),
  payValue:     z.number().nonnegative(),
});

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "finances", "full");
  if (denied) return denied;

  try {
    const data = schema.parse(await req.json());

    const rate = await prisma.privateLessonPayRate.upsert({
      where: { userId_lessonTypeId: { userId: params.id, lessonTypeId: data.lessonTypeId } },
      update: { payType: data.payType, payValue: data.payValue },
      create: {
        clubId:       session.user.clubId,
        userId:       params.id,
        lessonTypeId: data.lessonTypeId,
        payType:      data.payType,
        payValue:     data.payValue,
      },
      include: { lessonType: { select: { title: true } } },
    });

    return NextResponse.json(rate, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}

export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "finances", "full");
  if (denied) return denied;

  const { searchParams } = new URL(req.url);
  const lessonTypeId = searchParams.get("lessonTypeId");
  if (!lessonTypeId) return NextResponse.json({ error: "lessonTypeId required" }, { status: 400 });

  const existing = await prisma.privateLessonPayRate.findFirst({
    where: { userId: params.id, lessonTypeId, clubId: session.user.clubId },
  });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.privateLessonPayRate.delete({
    where: { userId_lessonTypeId: { userId: params.id, lessonTypeId } },
  });

  return new NextResponse(null, { status: 204 });
}
