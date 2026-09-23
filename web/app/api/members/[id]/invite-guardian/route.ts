import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { rateLimit, rateLimitedResponse } from "@/lib/ratelimit";
import { sendJoinInvite } from "@/lib/migrationServer";

// POST /api/members/[id]/invite-guardian — B15.
//
// "Invite this athlete's guardian to create a parent account." For a minor who
// is ALREADY a member (active subscription, migration completed) there was no
// owner-side way to get the parent a login: the activation resend refuses
// completed migrations, the registration link refuses active members, and the
// Family & access card can only link an account that already exists. This
// sends the parent-account variant of the registration link; completing it
// creates the guardian's login and the guardian link, and nothing else.
export async function POST(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "members", "edit");
  if (denied) return denied;

  const rl = rateLimit({ key: `members:invite-guardian:${session.user.id}`, limit: 30, windowMs: 60_000 });
  if (!rl.allowed) return rateLimitedResponse(rl, "Too many invitations at once. Wait a moment and try again.");

  const member = await prisma.member.findFirst({
    where: { id, clubId: session.user.clubId, deletedAt: null },
    select: { id: true, isMinor: true, guardianEmail: true },
  });
  if (!member) return NextResponse.json({ error: "Member not found" }, { status: 404 });
  if (!member.isMinor || !member.guardianEmail) {
    return NextResponse.json(
      { error: "This invite is for a minor with a guardian email on file. Add the guardian email on the profile first." },
      { status: 409 },
    );
  }

  const result = await sendJoinInvite(member.id, session.user.clubId, session.user.id, { guardianLogin: true });
  if (!result.ok) {
    return NextResponse.json({ error: result.reason ?? "Could not send the invite.", reason: result.reason }, { status: 409 });
  }
  return NextResponse.json({ ok: true, sentTo: result.sentTo });
}
