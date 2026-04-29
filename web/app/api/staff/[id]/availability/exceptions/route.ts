import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.id !== params.id)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const exceptions = await prisma.staffAvailabilityException.findMany({
    where: { userId: params.id, clubId: session.user.clubId },
    orderBy: { date: "asc" },
  });

  return NextResponse.json(exceptions);
}

const schema = z.object({
  date:      z.string(),
  type:      z.enum(["UNAVAILABLE", "PARTIAL"]),
  startTime: z.string().regex(/^\d{2}:\d{2}$/).optional().nullable(),
  endTime:   z.string().regex(/^\d{2}:\d{2}$/).optional().nullable(),
  note:      z.string().max(200).optional().nullable(),
});

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.id !== params.id)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const data = schema.parse(await req.json());

    const exception = await prisma.staffAvailabilityException.create({
      data: {
        userId:    params.id,
        clubId:    session.user.clubId,
        date:      new Date(data.date),
        type:      data.type,
        startTime: data.startTime || null,
        endTime:   data.endTime || null,
        note:      data.note || null,
      },
    });

    return NextResponse.json(exception, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.id !== params.id)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const exceptionId = searchParams.get("exceptionId");
  if (!exceptionId) return NextResponse.json({ error: "exceptionId required" }, { status: 400 });

  const existing = await prisma.staffAvailabilityException.findFirst({
    where: { id: exceptionId, userId: params.id, clubId: session.user.clubId },
  });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.staffAvailabilityException.delete({ where: { id: exceptionId } });
  return new NextResponse(null, { status: 204 });
}
