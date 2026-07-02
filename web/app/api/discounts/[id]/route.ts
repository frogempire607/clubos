import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requirePermission } from "@/lib/apiGuard";
import { prisma } from "@/lib/prisma";

const schema = z.object({
  code:          z.string().min(1).max(50).toUpperCase().optional(),
  description:   z.string().max(200).optional().nullable(),
  type:          z.enum(["PERCENT", "FIXED"]).optional(),
  value:         z.number().positive().optional(),
  maxUses:       z.number().int().positive().optional().nullable(),
  active:        z.boolean().optional(),
  expiresAt:     z.string().optional().nullable(),
  membershipIds: z.array(z.string()).optional(),
});

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "events", "edit");
  if (denied) return denied;

  const existing = await prisma.discount.findFirst({
    where: { id: params.id, clubId: session.user.clubId },
  });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const body = schema.parse(await req.json());
    const updated = await prisma.discount.update({
      where: { id: params.id },
      data: {
        ...body,
        expiresAt: body.expiresAt !== undefined
          ? (body.expiresAt ? new Date(body.expiresAt) : null)
          : undefined,
      },
    });
    return NextResponse.json(updated);
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}

export async function DELETE(_req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "events", "edit");
  if (denied) return denied;

  const existing = await prisma.discount.findFirst({
    where: { id: params.id, clubId: session.user.clubId },
  });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.discount.delete({ where: { id: params.id } });
  return new NextResponse(null, { status: 204 });
}
