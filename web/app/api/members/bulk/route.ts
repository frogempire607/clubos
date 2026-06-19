import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sendMemberMessage } from "@/lib/memberMessaging";
import { sendJoinInvite } from "@/lib/migrationServer";
import { deleteOrphanedMemberLogins } from "@/lib/memberLink";

// `delete` is a single bulk DB update, so it can take a large selection (a club
// clearing out an import can easily exceed 500). `message` and
// `send_registration_link` loop per member and send email, so they're capped
// lower below to stay within the serverless time budget.
const MAX_IDS = 5000;
const LOOP_ACTION_LIMIT = 200;

const schema = z.object({
  action: z.enum(["delete", "message", "send_registration_link"]),
  memberIds: z.array(z.string().min(1)).min(1).max(MAX_IDS),
  body: z.string().min(1).max(4000).optional(),
});

// POST /api/members/bulk
// Owner/staff bulk action over selected members:
//   { action: "delete", memberIds }              → soft-delete each
//   { action: "message", memberIds, body }       → DM each (athlete + guardian)
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let data: z.infer<typeof schema>;
  try {
    data = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  // Scope to this club only.
  const owned = await prisma.member.findMany({
    where: { id: { in: data.memberIds }, clubId: session.user.clubId, deletedAt: null },
    select: { id: true, userId: true },
  });
  const ids = owned.map((m) => m.id);
  if (ids.length === 0) return NextResponse.json({ error: "No matching members." }, { status: 404 });

  // The email-sending actions run a per-member loop; cap them so one request
  // can't blow the serverless time budget. (delete is a single bulk update.)
  if (
    (data.action === "message" || data.action === "send_registration_link") &&
    ids.length > LOOP_ACTION_LIMIT
  ) {
    return NextResponse.json(
      { error: `You can only do that for up to ${LOOP_ACTION_LIMIT} members at once. Select fewer and try again.` },
      { status: 400 },
    );
  }

  if (data.action === "delete") {
    // Release the unique members_userId slot on delete (the index is global and
    // ignores deletedAt) so these people can be re-imported / re-activated later.
    await prisma.member.updateMany({
      where: { id: { in: ids } },
      data: { deletedAt: new Date(), userId: null },
    });
    // Also remove each member's own login (skips shared guardian + owner/staff
    // accounts) so deleted members can no longer sign in.
    await deleteOrphanedMemberLogins(owned.map((m) => m.userId), session.user.clubId);
    return NextResponse.json({ ok: true, deleted: ids.length });
  }

  // #7: send a free-join registration link to each selected non-member.
  if (data.action === "send_registration_link") {
    let sent = 0;
    const skipped: { memberId: string; reason: string }[] = [];
    for (const memberId of ids) {
      const r = await sendJoinInvite(memberId, session.user.clubId, session.user.id);
      if (r.ok) sent++;
      else skipped.push({ memberId, reason: r.reason ?? "Could not send" });
    }
    return NextResponse.json({ ok: true, sent, skipped });
  }

  // action === "message"
  if (!data.body?.trim()) {
    return NextResponse.json({ error: "Message body is required." }, { status: 400 });
  }

  let sent = 0;
  const skipped: { memberId: string; reason: string }[] = [];
  for (const memberId of ids) {
    const result = await sendMemberMessage({
      clubId: session.user.clubId,
      senderId: session.user.id,
      memberId,
      body: data.body.trim(),
    });
    if (result.ok) sent++;
    else skipped.push({ memberId, reason: result.error ?? "Could not deliver" });
  }

  return NextResponse.json({ ok: true, sent, skipped });
}
