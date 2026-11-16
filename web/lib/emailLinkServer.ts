// Connecting a login to records that share its email — AFTER the address has
// been proved. The rule and the token are in lib/emailVerification.ts; this is
// the database half, and the ONLY place those links are made.
//
// Two kinds of match, both made by somebody else's typing (the club's roster,
// an import, a staff member at the front desk):
//   own record   a member row with this email and no login yet
//   children     minors whose guardian email is this email

import { prisma } from "@/lib/prisma";
import { isOwnerVouched, requestGuardianLink } from "@/lib/guardianLink";
import { createGuardianConsentRequest } from "@/lib/parentalConsent";
import { sendEmail, sendGuardianConsentRequestEmail } from "@/lib/email";
import { getAppBaseUrl } from "@/lib/baseUrl";
import {
  emailFingerprint,
  isEmailVerified,
  readVerificationToken,
  signVerificationToken,
  verificationProblemMessage,
} from "@/lib/emailVerification";

const secret = () => process.env.NEXTAUTH_SECRET;

type Account = { id: string; clubId: string; email: string; firstName: string; emailVerified: Date | null; createdAt: Date };

async function findMatches(account: Pick<Account, "id" | "clubId" | "email">) {
  const email = account.email.toLowerCase();
  const [hasOwnProfile, ownRecord, children] = await Promise.all([
    prisma.member.findFirst({ where: { userId: account.id, clubId: account.clubId, deletedAt: null }, select: { id: true } }),
    prisma.member.findFirst({
      where: { clubId: account.clubId, email, deletedAt: null, userId: null },
      select: { id: true, isMinor: true, firstName: true, lastName: true, guardianName: true, guardianEmail: true, guardianRelationship: true },
    }),
    prisma.member.findMany({
      where: {
        clubId: account.clubId,
        deletedAt: null,
        isMinor: true,
        guardianEmail: { equals: email, mode: "insensitive" },
        // Not already linked (in any state) to this account.
        guardianLinks: { none: { userId: account.id } },
      },
      select: { id: true, isMinor: true, guardianEmail: true },
    }),
  ]);
  return {
    ownRecord: hasOwnProfile ? null : ownRecord,
    children: children.filter((c) => c.id !== ownRecord?.id && isOwnerVouched(c, email)),
  };
}

/** Is there anything waiting on this account proving its address? Cheap; no writes. */
export async function emailLinkStatus(account: Account): Promise<{ verified: boolean; pending: boolean }> {
  if (isEmailVerified(account)) return { verified: true, pending: false };
  const m = await findMatches(account);
  return { verified: false, pending: !!m.ownRecord || m.children.length > 0 };
}

export type EmailLinkResult = { linkedOwnRecord: boolean; linkedChildren: number };

/**
 * Make every link this address is entitled to. Call ONLY for an account whose
 * address is proven. Safe to call again: each link is made at most once.
 */
export async function completeEmailLinks(account: Pick<Account, "id" | "clubId" | "email">): Promise<EmailLinkResult> {
  const { ownRecord, children } = await findMatches(account);
  let linkedOwnRecord = false;

  if (ownRecord) {
    // Conditional on the slot still being free: two tabs, or a staff member
    // linking the same record at the same moment, must not both win.
    const claimed = await prisma.member.updateMany({ where: { id: ownRecord.id, userId: null }, data: { userId: account.id } });
    linkedOwnRecord = claimed.count === 1;

    // A minor's own login stays locked until a guardian consents. Ask the
    // guardian THE CLUB has on file — never an address typed at signup.
    if (linkedOwnRecord && ownRecord.isMinor && ownRecord.guardianEmail) {
      try {
        const open = await prisma.guardianConsentRequest.findFirst({ where: { memberId: ownRecord.id, consumedAt: null }, select: { id: true } });
        if (!open) {
          const club = await prisma.club.findUnique({ where: { id: account.clubId }, select: { name: true } });
          const req = await createGuardianConsentRequest(prisma, {
            clubId: account.clubId,
            memberId: ownRecord.id,
            guardianName: ownRecord.guardianName,
            guardianEmail: ownRecord.guardianEmail.toLowerCase(),
            relationship: ownRecord.guardianRelationship,
            source: "SIGNUP",
          });
          await sendGuardianConsentRequestEmail({
            to: ownRecord.guardianEmail.toLowerCase(),
            guardianName: ownRecord.guardianName ?? undefined,
            childName: `${ownRecord.firstName} ${ownRecord.lastName}`.trim(),
            clubName: club?.name ?? "your club",
            consentUrl: `${getAppBaseUrl()}/guardian-consent/${req.token}`,
            setPasswordUrl: null,
          });
        }
      } catch (e) {
        console.error("[email link] guardian consent request failed", e);
      }
    }
  }

  let linkedChildren = 0;
  for (const child of children) {
    try {
      const r = await requestGuardianLink({
        clubId: account.clubId,
        requestingUserId: account.id,
        requestingUserEmail: account.email.toLowerCase(),
        emailVerified: true,
        child,
        relationship: null,
      });
      if (r.status === "linked") linkedChildren++;
    } catch (e) {
      console.error("[email link] guardian link failed for child", child.id, e);
    }
  }
  return { linkedOwnRecord, linkedChildren };
}

/** Email the confirmation link. Never throws; resolves false if it could not be sent. */
export async function sendVerificationEmail(account: Pick<Account, "id" | "email" | "firstName">, clubName: string, baseUrl: string): Promise<boolean> {
  try {
    const token = signVerificationToken({ userId: account.id, email: account.email, now: new Date() }, secret());
    const url = `${baseUrl.replace(/\/$/, "")}/verify-email?token=${encodeURIComponent(token)}`;
    const safe = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
    await sendEmail({
      to: account.email,
      subject: `Confirm your email for ${clubName}`,
      fromName: clubName,
      html: `
        <div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:16px;line-height:1.55;color:#111111;max-width:520px">
          <p>Hi ${safe(account.firstName || "there")},</p>
          <p>Please confirm this is your email address. Once you do, any records ${safe(clubName)} already has under this address — yours, or children you look after — are connected to your account.</p>
          <p style="margin:24px 0"><a href="${url}" style="background:#6D5DF6;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;display:inline-block">Confirm my email</a></p>
          <p style="font-size:14px;color:#6B7280">The link works for 7 days. If you did not create an account with ${safe(clubName)}, ignore this email — nothing is connected unless the link is used.</p>
        </div>`,
    });
    return true;
  } catch (e) {
    console.error("[email verification] could not send", e);
    return false;
  }
}

export type ConfirmResult =
  | ({ ok: true; alreadyVerified: boolean } & EmailLinkResult)
  | { ok: false; status: 400 | 404 | 410 | 503; error: string };

/** Use a confirmation link: prove the address, then make the links. */
export async function confirmEmailWithToken(token: string | null | undefined): Promise<ConfirmResult> {
  const read = readVerificationToken(token, secret(), new Date());
  if (!read.ok) {
    return { ok: false, status: read.reason === "EXPIRED" ? 410 : read.reason === "NOT_CONFIGURED" ? 503 : 400, error: verificationProblemMessage(read.reason) };
  }
  const user = await prisma.user.findFirst({
    where: { id: read.claim.userId, deletedAt: null },
    select: { id: true, clubId: true, email: true, emailVerified: true },
  });
  if (!user) return { ok: false, status: 404, error: verificationProblemMessage("NO_ACCOUNT") };
  // The link proves ONE address. If the account's address changed since it was
  // sent, it proves nothing about the new one.
  if (emailFingerprint(user.email) !== read.claim.emailFingerprint) {
    return { ok: false, status: 400, error: verificationProblemMessage("ADDRESS_CHANGED") };
  }
  const alreadyVerified = !!user.emailVerified;
  if (!alreadyVerified) await prisma.user.update({ where: { id: user.id }, data: { emailVerified: new Date() } });
  const linked = await completeEmailLinks(user);
  return { ok: true, alreadyVerified, ...linked };
}

/**
 * Activation: the link was emailed, so finishing it proves an address — but
 * only the address it was SENT to. The activation form lets some people type a
 * different email, and that one is unproven. Spread the result into a user
 * create/update: `{ emailVerified }` when proved, `{}` when not.
 */
export async function provedByActivationLink(memberId: string, accountEmail: string): Promise<{ emailVerified?: Date }> {
  const sent = await prisma.memberInvitationDelivery.findFirst({
    where: { memberId, sentToEmail: { equals: accountEmail, mode: "insensitive" } },
    select: { id: true },
  });
  return sent ? { emailVerified: new Date() } : {};
}
