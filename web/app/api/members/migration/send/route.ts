import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { sendActivation } from "@/lib/migrationServer";
import { MIGRATION_STATUS } from "@/lib/migration";

// Cap per request so thousands of members send in safe batches. The UI loops
// until `remaining` is 0, showing progress.
const BATCH_CAP = 150;

const schema = z.object({
  memberIds: z.array(z.string()).optional(),
  // Target everyone not yet completed (initial blast or reminder sweep).
  scope: z.enum(["selected", "all_pending"]).default("selected"),
  reminder: z.boolean().optional().default(false),
});

// POST /api/members/migration/send
// Bulk-send activation links / reminders. Owner/staff with members:edit.
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "members", "edit");
  if (denied) return denied;

  const clubId = session.user.clubId;
  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json().catch(() => ({})));
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    throw err;
  }

  // Resolve the target set.
  let targetIds: string[];
  if (body.scope === "all_pending") {
    const pending = await prisma.member.findMany({
      where: {
        clubId,
        deletedAt: null,
        migrationStatus: {
          in: [MIGRATION_STATUS.IMPORTED, MIGRATION_STATUS.INVITED, MIGRATION_STATUS.ACTIVATED],
        },
      },
      select: { id: true },
      orderBy: { importedAt: "asc" },
    });
    targetIds = pending.map((m) => m.id);
  } else {
    targetIds = body.memberIds ?? [];
  }

  if (targetIds.length === 0) {
    return NextResponse.json({ error: "No members to send to." }, { status: 400 });
  }

  const batch = targetIds.slice(0, BATCH_CAP);
  const remaining = Math.max(0, targetIds.length - batch.length);

  let sent = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const id of batch) {
    const r = await sendActivation(id, clubId, session.user.id, body.reminder);
    if (r.ok) sent++;
    else {
      failed++;
      if (errors.length < 20) errors.push(`${id}: ${r.reason}`);
    }
  }

  return NextResponse.json({ ok: true, sent, failed, remaining, processed: batch.length, errors });
}
