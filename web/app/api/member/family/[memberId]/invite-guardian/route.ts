import { NextResponse } from "next/server";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { GUARDIAN_LINK_KIND } from "@/lib/guardianLink";
import { normalizeEmail } from "@/lib/memberValidation";
import { getAppBaseUrl } from "@/lib/baseUrl";
import { sendClubJoinInviteEmail } from "@/lib/email";

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
    // No account yet → create a pending portal account, email them an activation
    // link to set a password, and still file the guardian-link approval so the
    // owner can approve once they've activated. (Preferred over telling the
    // parent to have them sign up manually.)
    const token = crypto.randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    const placeholderHash = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 12);
    const first = (data.name || "").trim().split(/\s+/)[0] || "Guardian";
    const last = (data.name || "").trim().split(/\s+/).slice(1).join(" ") || "";
    const club = await prisma.club.findUnique({
      where: { id: session.user.clubId },
      select: { name: true, logoUrl: true, primaryColor: true, emailFromName: true, emailReplyTo: true },
    });
    // Resurrect a soft-deleted row if present; otherwise create a fresh account.
    const existingUser = await prisma.user.findUnique({
      where: { clubId_email: { clubId: session.user.clubId, email } },
      select: { id: true },
    });
    const newGuardian = existingUser
      ? await prisma.user.update({
          where: { id: existingUser.id },
          data: { deletedAt: null, role: "MEMBER", resetToken: token, resetExpires: expires },
          select: { id: true, firstName: true },
        })
      : await prisma.user.create({
          data: {
            clubId: session.user.clubId,
            email,
            role: "MEMBER",
            firstName: first,
            lastName: last,
            passwordHash: placeholderHash,
            resetToken: token,
            resetExpires: expires,
          },
          select: { id: true, firstName: true },
        });
    const baseUrl = getAppBaseUrl();
    try {
      await sendClubJoinInviteEmail({
        to: email,
        firstName: newGuardian.firstName || first,
        clubName: club?.name ?? "your club",
        clubLogoUrl: club?.logoUrl,
        clubPrimaryColor: club?.primaryColor,
        registrationUrl: `${baseUrl}/reset-password?token=${token}`,
        fromName: club?.emailFromName || club?.name || null,
        replyTo: club?.emailReplyTo || null,
      });
    } catch (e) {
      console.error("co-guardian invite email failed", e);
    }
    await prisma.pendingApproval.create({
      data: {
        clubId: session.user.clubId,
        memberId,
        kind: GUARDIAN_LINK_KIND,
        status: "PENDING",
        payload: {
          requestingUserId: newGuardian.id,
          requestingUserEmail: email,
          relationship: data.relationship || null,
          invitedByUserId: session.user.id,
          invitedName: data.name || null,
        } as Prisma.InputJsonValue,
      },
    });
    return NextResponse.json({
      status: "invited",
      message: `We emailed ${email} an invite to set up their account. Once they activate, your club can approve them as a guardian.`,
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
