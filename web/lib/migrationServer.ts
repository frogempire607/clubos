import { prisma } from "@/lib/prisma";
import { sendMemberMigrationActivationEmail, sendClubJoinInviteEmail } from "@/lib/email";
import { newActivationToken, MIGRATION_STATUS } from "@/lib/migration";
import { getAppBaseUrl } from "@/lib/baseUrl";
import { publicClubLogoUrl } from "@/lib/clubLogo";

const TOKEN_TTL_DAYS = 30;

// Recipient resolution: guardian email for minors, else member email, else
// guardian email. Returns null when there's nobody to email.
function recipientFor(m: {
  isMinor: boolean;
  email: string | null;
  guardianEmail: string | null;
}): string | null {
  if (m.isMinor) return m.guardianEmail || m.email || null;
  return m.email || m.guardianEmail || null;
}

// Generate/refresh the activation token, send the branded email, bump counters,
// and write an audit event. Returns a per-member result for bulk reporting.
export async function sendActivation(
  memberId: string,
  clubId: string,
  actorUserId: string | null,
  isReminder: boolean,
): Promise<{ ok: boolean; reason?: string }> {
  const member = await prisma.member.findFirst({
    where: { id: memberId, clubId, deletedAt: null },
  });
  if (!member) return { ok: false, reason: "not found" };
  if (member.migrationStatus === MIGRATION_STATUS.COMPLETED) {
    return { ok: false, reason: "already completed" };
  }

  const to = recipientFor(member);
  if (!to) return { ok: false, reason: "no email on file" };

  const club = await prisma.club.findUnique({
    where: { id: clubId },
    select: {
      name: true,
      slug: true,
      logoUrl: true,
      emailFromName: true,
      emailReplyTo: true,
      contactEmail: true,
    },
  });
  if (!club) return { ok: false, reason: "club missing" };

  // Reuse an unexpired token so reminder links stay stable.
  let token = member.activationToken;
  const expires = member.activationTokenExpires;
  if (!token || !expires || expires < new Date()) {
    token = newActivationToken();
  }
  const tokenExpires = new Date(Date.now() + TOKEN_TTL_DAYS * 86400000);
  const baseUrl = getAppBaseUrl();
  const activationUrl = `${baseUrl}/activate/${token}`;

  try {
    await sendMemberMigrationActivationEmail({
      to,
      athleteName: `${member.firstName} ${member.lastName}`.trim(),
      clubName: club.name,
      clubLogoUrl: publicClubLogoUrl(clubId, club.logoUrl),
      membershipName: member.legacyMembershipName,
      nextBillingDate: member.billingAnchorDate
        ? member.billingAnchorDate.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
        : null,
      activationUrl,
      isReminder,
      fromName: club.emailFromName || club.name,
      replyTo: club.emailReplyTo || club.contactEmail || null,
    });
  } catch (e) {
    return { ok: false, reason: `email failed: ${String(e)}` };
  }

  await prisma.member.update({
    where: { id: member.id },
    data: {
      activationToken: token,
      activationTokenExpires: tokenExpires,
      activationEmailSentAt: new Date(),
      activationEmailSendCount: { increment: 1 },
      // Don't downgrade ACTIVATED back to INVITED on a reminder.
      migrationStatus:
        member.migrationStatus === MIGRATION_STATUS.ACTIVATED
          ? member.migrationStatus
          : MIGRATION_STATUS.INVITED,
    },
  });

  await prisma.memberMigrationEvent.create({
    data: {
      clubId,
      memberId: member.id,
      type: isReminder ? "REMINDER_SENT" : "ACTIVATION_SENT",
      message: `${isReminder ? "Reminder" : "Activation link"} sent to ${to}`,
      actorUserId,
    },
  });

  await recordInvitationDelivery({
    clubId,
    memberId: member.id,
    sentToEmail: to,
    recipientKind: member.isMinor && member.guardianEmail === to ? "GUARDIAN" : "SELF",
    sentByUserId: actorUserId,
    trigger: actorUserId ? "STAFF" : "SYSTEM",
  });

  return { ok: true };
}

/**
 * One row per invitation actually sent.
 *
 * ── Why this exists (4.5.1, and B-4 in PROGRESS.md) ─────────────────────────
 *
 * Before this, the only record of an invitation was
 * `Member.activationEmailSendCount` — a counter. A counter cannot tell a BOUNCE
 * from an IGNORE, and those need opposite actions: a bounce means the address
 * is wrong and staff must fix it; an ignore means the address is fine and the
 * parent needs a phone call. `derivedBlockedReason` was falling back to "3
 * sends, never opened" for both, so the roster told staff to fix an address
 * that was correct.
 *
 * The address is frozen at send time on purpose: editing a member's email later
 * must not rewrite the history of where invitations actually went. That history
 * is what the password-reset dialog's bounce list reads.
 *
 * Failures here are swallowed. A delivery row is observability; losing one must
 * never turn a successfully-sent invitation into a failed one, which is the
 * error the caller would otherwise report to a staffer who watched it send.
 *
 * `deliveredAt` / `openedAt` / `bouncedAt` stay null on the SMTP path, which
 * gives no lifecycle callbacks — the UI must read that as "sent", never as
 * "not delivered". Populating them is the Resend webhook's job.
 */
export async function recordInvitationDelivery(input: {
  clubId: string;
  memberId: string;
  sentToEmail: string;
  recipientKind: "SELF" | "GUARDIAN";
  sentByUserId: string | null;
  trigger: "STAFF" | "BULK" | "SYSTEM" | "MEMBER_REQUEST";
  provider?: string | null;
  providerMessageId?: string | null;
}): Promise<void> {
  try {
    await prisma.memberInvitationDelivery.create({
      data: {
        clubId: input.clubId,
        memberId: input.memberId,
        sentToEmail: input.sentToEmail,
        recipientKind: input.recipientKind,
        sentByUserId: input.sentByUserId,
        trigger: input.trigger,
        provider: input.provider ?? (process.env.RESEND_API_KEY ? "RESEND" : "SMTP"),
        providerMessageId: input.providerMessageId ?? null,
      },
    });
  } catch (e) {
    console.error("[migrationServer] invitation delivery row failed", e);
  }
}

// Ensure a member has a valid activation token + INVITED status WITHOUT sending
// an email. Used for family onboarding: when one invite is emailed to a guardian
// for the whole family, every sibling still needs a token so the activation page
// can surface them and the guardian can "set up the next athlete" from the one
// email. Never downgrades ACTIVATED/COMPLETED.
export async function ensureActivationToken(
  memberId: string,
  clubId: string,
  actorUserId: string | null,
): Promise<{ ok: boolean; reason?: string }> {
  const member = await prisma.member.findFirst({
    where: { id: memberId, clubId, deletedAt: null },
  });
  if (!member) return { ok: false, reason: "not found" };
  if (
    member.migrationStatus === MIGRATION_STATUS.COMPLETED ||
    member.migrationStatus === MIGRATION_STATUS.ACTIVATED
  ) {
    return { ok: true }; // already past the invite stage — leave it.
  }

  let token = member.activationToken;
  const expires = member.activationTokenExpires;
  if (!token || !expires || expires < new Date()) {
    token = newActivationToken();
  }
  await prisma.member.update({
    where: { id: member.id },
    data: {
      activationToken: token,
      activationTokenExpires: new Date(Date.now() + TOKEN_TTL_DAYS * 86400000),
      migrationStatus: MIGRATION_STATUS.INVITED,
    },
  });
  await prisma.memberMigrationEvent.create({
    data: {
      clubId,
      memberId: member.id,
      type: "ACTIVATION_SENT",
      message: "Included in a family onboarding invite (no separate email sent)",
      actorUserId,
    },
  });
  return { ok: true };
}

// #7: send a free-join registration link to a NON-member. Reuses the activation
// token machinery but flags activationKind=JOIN and sends the "join the club"
// email. Skips anyone who already has an active membership.
export async function sendJoinInvite(
  memberId: string,
  clubId: string,
  actorUserId: string | null,
): Promise<{ ok: boolean; reason?: string }> {
  const member = await prisma.member.findFirst({
    where: { id: memberId, clubId, deletedAt: null },
  });
  if (!member) return { ok: false, reason: "not found" };

  const activeSub = await prisma.memberSubscription.findFirst({
    where: { memberId: member.id, status: "active" },
    select: { id: true },
  });
  if (activeSub) return { ok: false, reason: "already a member" };

  const to = recipientFor(member);
  if (!to) return { ok: false, reason: "no email on file" };

  const club = await prisma.club.findUnique({
    where: { id: clubId },
    select: {
      name: true,
      logoUrl: true,
      primaryColor: true,
      emailFromName: true,
      emailReplyTo: true,
      contactEmail: true,
    },
  });
  if (!club) return { ok: false, reason: "club missing" };

  // Reuse an unexpired token so re-sends stay stable.
  let token = member.activationToken;
  const expires = member.activationTokenExpires;
  if (!token || !expires || expires < new Date()) {
    token = newActivationToken();
  }
  const tokenExpires = new Date(Date.now() + TOKEN_TTL_DAYS * 86400000);
  const registrationUrl = `${getAppBaseUrl()}/activate/${token}`;

  try {
    await sendClubJoinInviteEmail({
      to,
      firstName: member.firstName,
      clubName: club.name,
      clubLogoUrl: publicClubLogoUrl(clubId, club.logoUrl),
      clubPrimaryColor: club.primaryColor,
      registrationUrl,
      fromName: club.emailFromName || club.name,
      replyTo: club.emailReplyTo || club.contactEmail || null,
    });
  } catch (e) {
    return { ok: false, reason: `email failed: ${String(e)}` };
  }

  await prisma.member.update({
    where: { id: member.id },
    data: {
      activationToken: token,
      activationTokenExpires: tokenExpires,
      activationEmailSentAt: new Date(),
      activationEmailSendCount: { increment: 1 },
      activationKind: "JOIN",
    },
  });

  await prisma.memberMigrationEvent.create({
    data: {
      clubId,
      memberId: member.id,
      type: "REGISTRATION_LINK_SENT",
      message: `Registration link sent to ${to}`,
      actorUserId,
    },
  });

  await recordInvitationDelivery({
    clubId,
    memberId: member.id,
    sentToEmail: to,
    recipientKind: member.isMinor && member.guardianEmail === to ? "GUARDIAN" : "SELF",
    sentByUserId: actorUserId,
    trigger: actorUserId ? "STAFF" : "SYSTEM",
  });

  return { ok: true };
}
