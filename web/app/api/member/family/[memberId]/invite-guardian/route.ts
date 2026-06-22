import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { GUARDIAN_LINK_KIND } from "@/lib/guardianLink";
import { normalizeEmail } from "@/lib/memberValidation";

// POST /api/member/family/[memberId]/invite-guardian
//
// A parent invites another guardian (e.g. a divorced co-parent) to also manage
// their child (#8b). To keep the security invariant intact — a MemberGuardianUser
// row only ever appears after OWNER approval — this just files a standard
// GUARDIAN_LINK request in the owner's Approvals queue, pointing at the
// co-guardian's existing portal account. The owner approves it exactly like any
// other guardian-link request and the existing approve route creates the link.
//
// The co-guardian must already have a portal account in this club (same
// constraint as linking an athlete). If they don't, we tell the parent to have
// them sign up first.
const schema = z.object({
  email: z.string().min(3),
  name: z.string().max(120).optional().nullable(),
  relationship: z.string().max(60).optional().nullable(),
});

export async function POST(req: Request, context: { params: Promise<{ memberId: string }> }) {
  const { memberId } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Caller must already be a guardian of this child.
  const viewer = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { guardianOf: { select: { member: { select: { id: true, clubId: true, firstName: true } } } } },
  });
  const child = viewer?.guardianOf.find((g) => g.member.id === memberId)?.member;
  if (!child || child.clubId !== session.user.clubId) {
    return NextResponse.json({ error: "Not a linked child" }, { status: 403 });
  }

  let data: z.infer<typeof schema>;
  try {
    data = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    throw err;
  }

  const email = normalizeEmail(data.email);
  if (!email) return NextResponse.json({ error: "Enter a valid email." }, { status: 400 });

  // The co-guardian needs an existing portal account in this club.
  const coGuardian = await prisma.user.findFirst({
    where: { clubId: session.user.clubId, email, deletedAt: null },
    select: { id: true },
  });
  if (!coGuardian) {
    return NextResponse.json({
      status: "needs_account",
      message: `We couldn't find a club account for ${email}. Ask them to create one at the member portal first, then invite them again.`,
    });
  }
  if (coGuardian.id === session.user.id) {
    return NextResponse.json({ error: "You're already a guardian for this athlete." }, { status: 400 });
  }

  // Already linked?
  const alreadyLinked = await prisma.memberGuardianUser.findUnique({
    where: { userId_memberId: { userId: coGuardian.id, memberId } },
    select: { userId: true },
  });
  if (alreadyLinked) {
    return NextResponse.json({ status: "already", message: "That person is already a guardian for this athlete." });
  }

  // Don't stack duplicate PENDING requests for the same co-guardian + child.
  const existing = await prisma.pendingApproval.findMany({
    where: { clubId: session.user.clubId, memberId, kind: GUARDIAN_LINK_KIND, status: "PENDING" },
    select: { payload: true },
  });
  const dup = existing.some(
    (r) => (r.payload as { requestingUserId?: string } | null)?.requestingUserId === coGuardian.id,
  );
  if (!dup) {
    await prisma.pendingApproval.create({
      data: {
        clubId: session.user.clubId,
        memberId,
        kind: GUARDIAN_LINK_KIND,
        status: "PENDING",
        payload: {
          requestingUserId: coGuardian.id,
          requestingUserEmail: email,
          relationship: data.relationship || null,
          invitedByUserId: session.user.id,
          invitedName: data.name || null,
        } as Prisma.InputJsonValue,
      },
    });
  }

  return NextResponse.json({
    status: "pending",
    message: "Request sent — your club will review and approve the added guardian.",
  });
}
