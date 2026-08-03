import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { relationshipConflictFor } from "@/lib/familyRules";

const REL_TYPES = ["SIBLING", "COUSIN", "FRIEND", "TEAMMATE", "PARENT", "CHILD", "SPOUSE", "OTHER"] as const;

const createSchema = z.object({
  relatedMemberId: z.string().min(1),
  type: z.enum(REL_TYPES),
  note: z.string().max(200).optional().nullable(),
});

// POST /api/members/[id]/relationships  — link two members
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: z.infer<typeof createSchema>;
  try {
    body = createSchema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  // Direction-insensitive duplicate + self checks live in lib/familyRules so
  // §4D can cover them without a database.
  if (relationshipConflictFor({ memberId: id, relatedMemberId: body.relatedMemberId }, []) === "SELF") {
    return NextResponse.json({ error: "A member can't be related to themselves." }, { status: 400 });
  }

  // Both members must belong to this club.
  const [a, b] = await Promise.all([
    prisma.member.findFirst({ where: { id, clubId: session.user.clubId, deletedAt: null }, select: { id: true } }),
    prisma.member.findFirst({ where: { id: body.relatedMemberId, clubId: session.user.clubId, deletedAt: null }, select: { id: true } }),
  ]);
  if (!a || !b) return NextResponse.json({ error: "Member not found" }, { status: 404 });

  // Reject if a link already exists in either direction.
  const existingRows = await prisma.memberRelationship.findMany({
    where: {
      clubId: session.user.clubId,
      OR: [
        { memberId: id, relatedMemberId: body.relatedMemberId },
        { memberId: body.relatedMemberId, relatedMemberId: id },
      ],
    },
    select: { memberId: true, relatedMemberId: true },
  });
  const conflict = relationshipConflictFor(
    { memberId: id, relatedMemberId: body.relatedMemberId },
    existingRows,
  );
  if (conflict) {
    return NextResponse.json(
      {
        error:
          conflict === "REVERSE_DUPLICATE"
            ? "These members are already linked — the label lives on the other profile and shows on both."
            : "These members are already linked.",
        code: conflict,
      },
      { status: 409 },
    );
  }

  const rel = await prisma.memberRelationship.create({
    data: {
      clubId: session.user.clubId,
      memberId: id,
      relatedMemberId: body.relatedMemberId,
      type: body.type,
      note: body.note || null,
    },
  });
  return NextResponse.json(rel, { status: 201 });
}

// DELETE /api/members/[id]/relationships?relationshipId=...
export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const relationshipId = new URL(req.url).searchParams.get("relationshipId");
  if (!relationshipId) return NextResponse.json({ error: "relationshipId required" }, { status: 400 });

  const rel = await prisma.memberRelationship.findFirst({
    where: {
      id: relationshipId,
      clubId: session.user.clubId,
      OR: [{ memberId: id }, { relatedMemberId: id }],
    },
  });
  if (!rel) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.memberRelationship.delete({ where: { id: rel.id } });
  return NextResponse.json({ ok: true });
}
