import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const schema = z.object({
  childEmail:   z.string().email(),
  relationship: z.string().optional(),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "MEMBER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = schema.parse(await req.json());

    // Find the child's Member record in the same club
    const childMember = await prisma.member.findFirst({
      where: {
        clubId:    session.user.clubId,
        email:     body.childEmail.toLowerCase(),
        deletedAt: null,
      },
    });

    if (!childMember) {
      return NextResponse.json(
        { error: "No member found with that email in your club. Ask your club owner to add them first." },
        { status: 404 }
      );
    }

    // Prevent linking yourself
    const self = await prisma.user.findUnique({
      where: { id: session.user.id },
      include: { memberProfile: true },
    });
    if (self?.memberProfile?.id === childMember.id) {
      return NextResponse.json({ error: "You cannot link yourself as your own child." }, { status: 400 });
    }

    // Upsert portal access link (a User claiming guardianship of a Member)
    const guardian = await prisma.memberGuardianUser.upsert({
      where: { userId_memberId: { userId: session.user.id, memberId: childMember.id } },
      update: { relationship: body.relationship || null },
      create: {
        userId:       session.user.id,
        memberId:     childMember.id,
        relationship: body.relationship || null,
      },
    });

    return NextResponse.json({ ok: true, childMember, guardian }, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
