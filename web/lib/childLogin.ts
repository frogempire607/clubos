import crypto from "crypto";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/lib/email";
import { getAppBaseUrl } from "@/lib/baseUrl";
import type { Member } from "@prisma/client";

const INVITE_TTL_DAYS = 7;

export type ChildLoginControls = {
  requirePaymentApproval?: boolean;
  allowOwnMessaging?: boolean;
  allowPackagePurchase?: boolean;
};

/**
 * Give a guardian-managed minor their OWN portal login.
 *
 * Model: the child gets their own User (Member.userId points at it) so they can
 * sign in and act for themselves, while the guardian KEEPS access via the
 * existing MemberGuardianUser link and remains the billing manager. What the
 * child may do on their own is governed by Member.parentControls (booking
 * approval, messaging, package purchases) — passed in here.
 *
 * No schema change: we create the child User with an unusable random password
 * plus a reset token and email them the standard "set your password" link.
 */
export async function inviteChildLogin(args: {
  member: Pick<Member, "id" | "clubId" | "firstName" | "lastName" | "isMinor" | "userId" | "guardianEmail">;
  childEmail: string;
  controls?: ChildLoginControls;
  club: { name: string; slug: string };
  actorUserId: string | null;
}): Promise<{ ok: true; resent: boolean } | { ok: false; error: string }> {
  const { member, club } = args;
  const email = args.childEmail.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: "Enter a valid email for the child." };
  }
  if (member.guardianEmail && email === member.guardianEmail.toLowerCase()) {
    return { ok: false, error: "The child needs an email that's different from the guardian's." };
  }

  const controls = args.controls ?? {};
  const parentControls = {
    // Default ON: the parent approves the child's paid bookings unless they turn
    // it off. Safer default for a brand-new independent minor login.
    requirePaymentApproval: controls.requirePaymentApproval ?? true,
    allowOwnMessaging: controls.allowOwnMessaging ?? true,
    allowPackagePurchase: controls.allowPackagePurchase ?? true,
  };

  const resetToken = crypto.randomBytes(32).toString("hex");
  const resetExpires = new Date(Date.now() + INVITE_TTL_DAYS * 86400000);
  const randomHash = await bcrypt.hash(crypto.randomBytes(24).toString("hex"), 12);

  // Is there already a User for this (club, email)?
  const existing = await prisma.user.findUnique({
    where: { clubId_email: { clubId: member.clubId, email } },
    select: { id: true, deletedAt: true, memberProfile: { select: { id: true } } },
  });

  let childUserId: string;
  let resent = false;
  if (existing && !existing.deletedAt) {
    // A live account already owns this email.
    if (existing.memberProfile && existing.memberProfile.id !== member.id) {
      return { ok: false, error: "That email already has an account at this club." };
    }
    // It's already this child's login (or an unlinked live user we can attach) —
    // just (re)issue a set-password link.
    childUserId = existing.id;
    resent = true;
    await prisma.user.update({
      where: { id: existing.id },
      data: { resetToken, resetExpires, role: "MEMBER" },
    });
  } else if (existing && existing.deletedAt) {
    // Resurrect a soft-deleted login for this email.
    childUserId = existing.id;
    await prisma.user.update({
      where: { id: existing.id },
      data: {
        deletedAt: null,
        passwordHash: randomHash,
        resetToken,
        resetExpires,
        role: "MEMBER",
        firstName: member.firstName,
        lastName: member.lastName,
      },
    });
  } else {
    const created = await prisma.user.create({
      data: {
        clubId: member.clubId,
        email,
        passwordHash: randomHash,
        firstName: member.firstName,
        lastName: member.lastName,
        role: "MEMBER",
        resetToken,
        resetExpires,
      },
      select: { id: true },
    });
    childUserId = created.id;
  }

  // Link the child's own login + store their email + the parental controls.
  // Only set userId when it isn't already pointed at a *different* user.
  await prisma.member.update({
    where: { id: member.id },
    data: {
      email,
      parentControls,
      ...(member.userId && member.userId !== childUserId ? {} : { userId: childUserId }),
    },
  });

  // Email the child a set-password link (reuses the reset-password page).
  const setupUrl = `${getAppBaseUrl()}/reset-password?token=${resetToken}`;
  await sendEmail({
    to: email,
    subject: `Set up your ${club.name} login`,
    html: `
      <p>Hi ${member.firstName},</p>
      <p>Your guardian set up a ${club.name} account for you. Create your password to sign in:</p>
      <p><a href="${setupUrl}">${setupUrl}</a></p>
      <p style="color:#777;font-size:12px">This link expires in ${INVITE_TTL_DAYS} days. Your guardian still manages billing and can adjust what you can do from their account.</p>
    `,
  }).catch((e) => console.error("[childLogin] invite email failed:", e));

  return { ok: true, resent };
}
