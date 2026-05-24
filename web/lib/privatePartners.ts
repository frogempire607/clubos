import { randomBytes } from "crypto";
import { prisma } from "@/lib/prisma";

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
  const partners = await prisma.privateBookingPartner.findMany({
    where: { bookingId: params.bookingId, clubId: params.clubId },
    include: { member: { select: { id: true, firstName: true, lastName: true, userId: true } } },
  });

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
