// Phase 4.5.2 §1g — "Resend invitation" for ONE member.
//
// The bulk sender at /api/members/migration/send has existed for a while, but
// the row-level menu item had nothing to call, so it silently did nothing. This
// is a thin, single-member wrapper over the SAME `sendActivation` — deliberately
// not a second invitation engine. Token reuse, TTL, the INVITED transition and
// the MemberMigrationEvent audit row all stay where they already live.
//
// `isReminder` is derived, not passed: a member who has already been emailed
// gets the reminder wording, a member who hasn't gets the first-contact wording.
// Letting the client choose would put the copy a family reads in the hands of
// whichever button was clicked last.

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { sendActivation } from "@/lib/migrationServer";
import { rateLimit, rateLimitedResponse } from "@/lib/ratelimit";

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "members", "edit");
  if (denied) return denied;

  const rl = rateLimit({ key: `members:resend-invite:${session.user.id}`, limit: 30, windowMs: 60_000 });
  if (!rl.allowed) return rateLimitedResponse(rl, "Too many invitations at once. Wait a moment and try again.");

  const member = await prisma.member.findFirst({
    where: { id: params.id, clubId: session.user.clubId, deletedAt: null },
    select: { activationEmailSentAt: true, activationEmailSendCount: true },
  });
  if (!member) return NextResponse.json({ error: "Member not found" }, { status: 404 });

  const isReminder = !!member.activationEmailSentAt || (member.activationEmailSendCount ?? 0) > 0;

  const result = await sendActivation(params.id, session.user.clubId, session.user.id, isReminder);
  if (!result.ok) {
    // `sendActivation` distinguishes "no email on file" from "already completed";
    // pass the distinction through so the roster can say which, not just "failed".
    const status = result.reason === "no email on file" ? 409 : 400;
    return NextResponse.json({ error: result.reason ?? "Could not send the invitation.", reason: result.reason }, { status });
  }

  return NextResponse.json({ ok: true, isReminder });
}
