import { NextResponse } from "next/server";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";

const patchSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().max(2000).optional().nullable(),
  price: z.number().nonnegative().optional(),
  published: z.boolean().optional(),
  // When provided, replaces the bundle's full set of events.
  eventIds: z.array(z.string()).optional(),
  paymentMethods: z.array(z.enum(["CARD", "CASH", "CHECK", "PAY_LATER"])).optional().nullable(),
});

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "events", "edit");
  if (denied) return denied;

  const bundle = await prisma.eventBundle.findFirst({
    where: { id, clubId: session.user.clubId, deletedAt: null },
    select: { id: true },
  });
  if (!bundle) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const data = patchSchema.parse(await req.json());

    let itemsUpdate = {};
    if (data.eventIds !== undefined) {
      const validIds = data.eventIds.length
        ? (
            await prisma.event.findMany({
              where: { id: { in: data.eventIds }, clubId: session.user.clubId, deletedAt: null },
              select: { id: true },
            })
          ).map((e) => e.id)
        : [];
      // Replace the membership set: clear then re-create.
      itemsUpdate = { items: { deleteMany: {}, create: validIds.map((eventId) => ({ eventId })) } };
    }

    const updated = await prisma.eventBundle.update({
      where: { id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.description !== undefined ? { description: data.description?.trim() || null } : {}),
        ...(data.price !== undefined ? { price: data.price } : {}),
        ...(data.published !== undefined ? { published: data.published } : {}),
        ...(data.paymentMethods !== undefined ? { paymentMethods: data.paymentMethods ?? undefined } : {}),
        ...itemsUpdate,
      },
      include: { items: true },
    });
    return NextResponse.json(updated);
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
    console.error(err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}

export async function DELETE(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "events", "edit");
  if (denied) return denied;

  const bundle = await prisma.eventBundle.findFirst({
    where: { id, clubId: session.user.clubId, deletedAt: null },
    select: { id: true },
  });
  if (!bundle) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.eventBundle.update({ where: { id }, data: { deletedAt: new Date() } });
  return NextResponse.json({ ok: true });
}
