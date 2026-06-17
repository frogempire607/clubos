import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sendMemberMessage } from "@/lib/memberMessaging";
import { sendJoinInvite } from "@/lib/migrationServer";

const schema = z.object({
  action: z.enum(["delete", "message", "send_registration_link"]),
  memberIds: z.array(z.string().min(1)).min(1).max(500),
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
    select: { id: true },
  });
  const ids = owned.map((m) => m.id);
  if (ids.length === 0) return NextResponse.json({ error: "No matching members." }, { status: 404 });

  if (data.action === "delete") {
    // Release the unique members_userId slot on delete (the index is global and
    // ignores deletedAt) so these people can be re-imported / re-activated later.
    await prisma.member.updateMany({
      where: { id: { in: ids } },
      data: { deletedAt: new Date(), userId: null },
    });
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
