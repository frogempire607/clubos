import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolvePermissions } from "@/lib/permissions";

const permissionLevel = z.enum(["none", "view", "edit", "full", "send"]);

const updateSchema = z.object({
  title: z.string().optional().nullable(),
  hourlyRate: z.number().nullable().optional(),
  salary: z.number().nullable().optional(),
  appointmentPrice: z.number().nullable().optional(),
  perSessionRate: z.number().nullable().optional(),
  bio: z.string().max(2000).optional().nullable(),
  publicEmail: z.string().optional().nullable(),
  publicPhone: z.string().optional().nullable(),
  photoUrl: z.string().optional().nullable(),
  showOnPortal: z.boolean().optional(),
  permissions: z.record(z.string(), permissionLevel).optional(),
});

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await prisma.user.findFirst({
    where: { id: params.id, clubId: session.user.clubId, role: "STAFF" },
    include: { staffProfile: true },
  });
  if (!user) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const data = updateSchema.parse(await req.json());

    const profileData = {
      ...(data.title !== undefined && { title: data.title }),
      ...(data.hourlyRate !== undefined && { hourlyRate: data.hourlyRate }),
      ...(data.salary !== undefined && { salary: data.salary }),
      ...(data.appointmentPrice !== undefined && { appointmentPrice: data.appointmentPrice }),
      ...(data.perSessionRate !== undefined && { perSessionRate: data.perSessionRate }),
      ...(data.bio !== undefined && { bio: data.bio }),
      ...(data.publicEmail !== undefined && { publicEmail: data.publicEmail }),
      ...(data.publicPhone !== undefined && { publicPhone: data.publicPhone }),
      ...(data.photoUrl !== undefined && { photoUrl: data.photoUrl }),
      ...(data.showOnPortal !== undefined && { showOnPortal: data.showOnPortal }),
      ...(data.permissions && { permissions: resolvePermissions(data.permissions) }),
    };

    if (user.staffProfile) {
      await prisma.staffProfile.update({ where: { userId: user.id }, data: profileData });
    } else {
      await prisma.staffProfile.create({
        data: {
          userId: user.id,
          ...profileData,
          permissions: resolvePermissions(data.permissions ?? null),
        },
      });
    }

    const updated = await prisma.user.findUnique({ where: { id: user.id }, include: { staffProfile: true } });
    return NextResponse.json(updated);
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors }, { status: 400 });
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function DELETE(_req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await prisma.user.findFirst({
    where: { id: params.id, clubId: session.user.clubId, role: "STAFF" },
  });
  if (!user) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.user.update({ where: { id: params.id }, data: { deletedAt: new Date() } });
  return NextResponse.json({ ok: true });
}
