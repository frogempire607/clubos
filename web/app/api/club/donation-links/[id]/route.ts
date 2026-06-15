import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const schema = z.object({
  title:               z.string().min(1).max(100).optional(),
  description:         z.string().max(500).optional().nullable(),
  url:                 z.string().url().optional().nullable(),
  stripePaymentLinkId: z.string().max(100).optional().nullable(),
  active:              z.boolean().optional(),
  legalEntityId:       z.string().optional().nullable(),
});

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = schema.parse(await req.json());

    const existing = await prisma.donationLink.findFirst({
      where: { id: params.id, clubId: session.user.clubId },
    });
    if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const link = await prisma.donationLink.update({
      where: { id: params.id },
      data: body,
      include: { legalEntity: { select: { id: true, name: true, entityType: true } } },
    });

    return NextResponse.json(link);
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors }, { status: 400 });
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}

export async function DELETE(_req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const existing = await prisma.donationLink.findFirst({
    where: { id: params.id, clubId: session.user.clubId },
  });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.donationLink.delete({ where: { id: params.id } });
  return new NextResponse(null, { status: 204 });
}
