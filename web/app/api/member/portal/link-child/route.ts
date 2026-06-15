import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requestGuardianLink } from "@/lib/guardianLink";

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
      select: { email: true, memberProfile: { select: { id: true } } },
    });
    if (self?.memberProfile?.id === childMember.id) {
      return NextResponse.json({ error: "You cannot link yourself as your own child." }, { status: 400 });
    }

    // Authorization gate (was: unconditional link by club + email only).
    // Auto-link ONLY when the owner already designated this requester as the
    // minor's guardian (childMember.guardianEmail === requester email).
    // Otherwise queue an owner approval and grant NO access until confirmed.
    const result = await requestGuardianLink({
      clubId: session.user.clubId,
      requestingUserId: session.user.id,
      requestingUserEmail: self?.email ?? null,
      child: { id: childMember.id, isMinor: childMember.isMinor, guardianEmail: childMember.guardianEmail },
      relationship: body.relationship || null,
    });

    if (result.status === "linked") {
      return NextResponse.json({ ok: true, linked: true }, { status: 201 });
    }
    return NextResponse.json(
      {
        ok: true,
        linked: false,
        pendingApproval: true,
        message:
          "Your request to manage this athlete was sent to the club for approval. " +
          "You'll get access once they confirm you're their guardian.",
      },
      { status: 202 },
    );
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
