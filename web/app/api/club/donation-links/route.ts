import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const links = await prisma.donationLink.findMany({
    where: { clubId: session.user.clubId },
    include: { legalEntity: { select: { id: true, name: true, entityType: true } } },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json(links);
}

const schema = z.object({
  title:               z.string().min(1).max(100),
  description:         z.string().max(500).optional().nullable(),
  url:                 z.string().url().optional().nullable(),
  stripePaymentLinkId: z.string().max(100).optional().nullable(),
  active:              z.boolean().optional(),
  legalEntityId:       z.string().optional().nullable(),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = schema.parse(await req.json());

    // Gate: club must have at least one NONPROFIT legal entity to create donation links
    const hasNonprofit = await prisma.legalEntity.findFirst({
      where: { clubId: session.user.clubId, entityType: "NONPROFIT" },
    });
    if (!hasNonprofit) {
      return NextResponse.json(
        { error: "Donation links require a Nonprofit legal entity. Add one under Business & Legal first." },
        { status: 403 }
      );
    }

    const link = await prisma.donationLink.create({
      data: {
        clubId: session.user.clubId,
        title: body.title,
        description: body.description || null,
        url: body.url || null,
        stripePaymentLinkId: body.stripePaymentLinkId || null,
        active: body.active ?? true,
        legalEntityId: body.legalEntityId || null,
      },
      include: { legalEntity: { select: { id: true, name: true, entityType: true } } },
    });

    return NextResponse.json(link, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors }, { status: 400 });
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
