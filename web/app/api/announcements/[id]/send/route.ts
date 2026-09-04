// POST /api/announcements/[id]/send
//
// Idempotent "Send now". Plan §3H "Prevent duplicate sends caused by
// retries, page refreshes, job restarts, or repeated clicks".
//
// Gates:
//   messages:send + messages.bulk sub-scope (announcement blasts are
//   the highest-blast-radius operation in the app).
// Tier gate: features.emailSms — Growth can't email at all.
//
// The idempotency contract lives in lib/announcementDispatch: it
// atomically claims the announcement (DRAFT|SCHEDULED → SENDING),
// dispatches through sendClubEmail (which itself dedupes on
// (sendBatchId, dedupeKey)), and finalizes to SENT. A second call
// while SENDING → 409 "already in progress"; a call after SENT → 409
// "already sent".

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission, requireMessagesSubScope } from "@/lib/apiGuard";
import { getTierFeatures } from "@/lib/tier";
import { dispatchAnnouncement } from "@/lib/announcementDispatch";

export const maxDuration = 60;

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "messages", "full");
  if (denied) return denied;
  const scopeDenied = requireMessagesSubScope(session, "bulk");
  if (scopeDenied) return scopeDenied;

  const ann = await prisma.announcement.findFirst({
    where: { id: params.id, clubId: session.user.clubId, deletedAt: null },
    select: { id: true, clubId: true, status: true, sendBatchId: true },
  });
  if (!ann) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Tier gate before dispatch — same as the bulk path. A Growth club
  // clicking Send should see the upgrade message, not a silent no-op.
  const club = await prisma.club.findUnique({
    where: { id: ann.clubId }, select: { tier: true },
  });
  const features = getTierFeatures(club?.tier ?? "growth");
  if (!features.emailSms) {
    return NextResponse.json(
      {
        error: "Your current plan does not include email blasts. Upgrade to Pro to send announcements by email.",
        code: "UPGRADE_REQUIRED",
        upgradeRequired: "pro",
      },
      { status: 403 },
    );
  }

  const result = await dispatchAnnouncement({
    announcementId: ann.id,
    actorUserId: session.user.id,
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: result.reason ?? "Send failed.", status: result.status, sendBatchId: result.sendBatchId },
      { status: result.status === "SENT" ? 409 : 400 },
    );
  }

  return NextResponse.json(result);
}
