import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// /api/staff/[id]/documents — OWNER only. Documents the owner uploads to a
// staff member's profile (tax docs, contracts, W-9s, agreements, etc.).
// Files are uploaded separately via /api/upload; this route stores the
// metadata + access flag.

const createSchema = z.object({
  title: z.string().min(1).max(200),
  fileUrl: z.string().min(1),
  fileId: z.string().optional().nullable(),
  fileName: z.string().optional().nullable(),
  mimeType: z.string().optional().nullable(),
  sizeBytes: z.number().int().nonnegative().optional().nullable(),
  kind: z.enum(["W9", "1099", "CONTRACT", "AGREEMENT", "CERTIFICATION", "OTHER"]).default("OTHER"),
  notes: z.string().max(2000).optional().nullable(),
  sharedWithStaff: z.boolean().optional().default(false),
});

async function requireStaffUser(clubId: string, userId: string) {
  return prisma.user.findFirst({
    where: { id: userId, clubId, deletedAt: null, role: { in: ["STAFF", "OWNER"] } },
    select: { id: true },
  });
}

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id: userId } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const staffUser = await requireStaffUser(session.user.clubId, userId);
  if (!staffUser) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const docs = await prisma.staffDocument.findMany({
    where: { clubId: session.user.clubId, userId, deletedAt: null },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json(docs);
}

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id: userId } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const staffUser = await requireStaffUser(session.user.clubId, userId);
  if (!staffUser) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let data: z.infer<typeof createSchema>;
  try {
    data = createSchema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    throw err;
  }

  const doc = await prisma.staffDocument.create({
    data: {
      clubId: session.user.clubId,
      userId,
      title: data.title,
      kind: data.kind,
      fileUrl: data.fileUrl,
      fileId: data.fileId || null,
      fileName: data.fileName || null,
      mimeType: data.mimeType || null,
      sizeBytes: data.sizeBytes ?? null,
      notes: data.notes || null,
      sharedWithStaff: data.sharedWithStaff ?? false,
      uploadedById: session.user.id,
    },
  });
  return NextResponse.json(doc, { status: 201 });
}
