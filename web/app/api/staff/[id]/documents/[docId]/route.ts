import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const patchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  kind: z.enum(["W9", "1099", "CONTRACT", "AGREEMENT", "CERTIFICATION", "OTHER"]).optional(),
  notes: z.string().max(2000).optional().nullable(),
  sharedWithStaff: z.boolean().optional(),
});

async function findDoc(clubId: string, userId: string, docId: string) {
  return prisma.staffDocument.findFirst({
    where: { id: docId, clubId, userId, deletedAt: null },
  });
}

export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string; docId: string }> },
) {
  const { id: userId, docId } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const doc = await findDoc(session.user.clubId, userId, docId);
  if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let data: z.infer<typeof patchSchema>;
  try {
    data = patchSchema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    throw err;
  }

  const updated = await prisma.staffDocument.update({
    where: { id: docId },
    data: {
      ...(data.title !== undefined ? { title: data.title } : {}),
      ...(data.kind !== undefined ? { kind: data.kind } : {}),
      ...(data.notes !== undefined ? { notes: data.notes ?? null } : {}),
      ...(data.sharedWithStaff !== undefined ? { sharedWithStaff: data.sharedWithStaff } : {}),
    },
  });
  return NextResponse.json(updated);
}

export async function DELETE(
  _req: Request,
  context: { params: Promise<{ id: string; docId: string }> },
) {
  const { id: userId, docId } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const doc = await findDoc(session.user.clubId, userId, docId);
  if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Soft delete — preserves the audit trail. The underlying file in
  // UploadedFile / /api/files store is left in place.
  await prisma.staffDocument.update({ where: { id: docId }, data: { deletedAt: new Date() } });
  return NextResponse.json({ ok: true });
}
