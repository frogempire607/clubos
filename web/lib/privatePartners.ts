import { randomBytes } from "crypto";
import { prisma } from "@/lib/prisma";
import { sendPartnerInviteEmail } from "@/lib/email";
import { getAppBaseUrl } from "@/lib/baseUrl";
import { publicClubLogoUrl } from "@/lib/clubLogo";

export type PartnerKind = "MEMBER" | "OUTSIDE" | "NEEDS_HELP";
export type PartnerStatus = "PENDING_COACH" | "INVITED" | "CONFIRMED" | "DECLINED";

export function generateInviteToken(): string {
  return randomBytes(24).toString("hex");
}

// Called when a coach/owner accepts a multi-athlete booking. Generates invite
// tokens for OUTSIDE partners (so the booker can share the link) and notifies
// MEMBER partners via DM. NEEDS_HELP partners stay PENDING_COACH — the coach
// still owes them a partner.
export async function activatePartnersOnAccept(params: {
  bookingId: string;
  clubId: string;
  senderId: string;
  lessonTitle: string;
  bookerName: string;
}) {
  const [partners, booking, club] = await Promise.all([
    prisma.privateBookingPartner.findMany({
      where: { bookingId: params.bookingId, clubId: params.clubId },
      include: { member: { select: { id: true, firstName: true, lastName: true, userId: true } } },
    }),
    // confirmedStartAt + lesson title are useful for the invite email,
    // but we already have the title on params; only need the start time.
    prisma.privateBooking.findUnique({
      where: { id: params.bookingId },
      select: { confirmedStartAt: true },
    }),
    prisma.club.findUnique({
      where: { id: params.clubId },
      select: {
        name: true,
        logoUrl: true,
        primaryColor: true,
        emailFromName: true,
        emailReplyTo: true,
      },
    }),
  ]);

  for (const p of partners) {
    if (p.status !== "PENDING_COACH") continue;

    if (p.kind === "OUTSIDE") {
      const token = p.inviteToken || generateInviteToken();
      const expires = p.inviteTokenExpiresAt ||
        new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
      await prisma.privateBookingPartner.update({
        where: { id: p.id },
        data: { status: "INVITED", inviteToken: token, inviteTokenExpiresAt: expires },
      });

      // Send the invite link directly to the outside partner when the
      // booker provided an email at request time. Best-effort: a
      // transport failure logs but doesn't break the accept flow. If
      // no email was collected, the booker still gets the shareable
      // link from their own portal (existing behaviour).
      if (p.outsideEmail && club) {
        try {
          await sendPartnerInviteEmail({
            to: p.outsideEmail,
            partnerName: p.outsideName || null,
            bookerName: params.bookerName,
            clubName: club.name,
            clubLogoUrl: publicClubLogoUrl(params.clubId, club.logoUrl),
            clubPrimaryColor: club.primaryColor,
            lessonTitle: params.lessonTitle,
            confirmedStartAt: booking?.confirmedStartAt ?? null,
            inviteUrl: `${getAppBaseUrl()}/privates/partner/${token}`,
            fromName: club.emailFromName || club.name,
            replyTo: club.emailReplyTo || null,
          });
        } catch (err) {
          console.error("[partner-invite] email failed", err);
        }
      }
    } else if (p.kind === "MEMBER" && p.memberId) {
      await prisma.privateBookingPartner.update({
        where: { id: p.id },
        data: { status: "INVITED" },
      });
      // Best-effort DM to the partner member's portal user (or guardian).
      try {
        const { sendMemberMessage } = await import("@/lib/memberMessaging");
        await sendMemberMessage({
          clubId: params.clubId,
          senderId: params.senderId,
          memberId: p.memberId,
          body: `${params.bookerName} has invited you to a partner private lesson ("${params.lessonTitle}"). Please open Private lessons in your portal to confirm or decline.`,
        });
      } catch {
        // messaging is best-effort; don't fail the accept flow
      }
    }
    // NEEDS_HELP: leave at PENDING_COACH — coach must still source a partner.
  }
}

export function summarizePartners(
  partners: Array<{
    kind: string;
    status: string;
    member?: { firstName: string; lastName: string } | null;
    outsideName?: string | null;
  }>,
): { total: number; confirmed: number; pending: number; needsHelp: number; outside: number } {
  let confirmed = 0, pending = 0, needsHelp = 0, outside = 0;
  for (const p of partners) {
    if (p.kind === "NEEDS_HELP") needsHelp++;
    else if (p.kind === "OUTSIDE") outside++;
    if (p.status === "CONFIRMED") confirmed++;
    else if (p.status !== "DECLINED") pending++;
  }
  return { total: partners.length, confirmed, pending, needsHelp, outside };
}
