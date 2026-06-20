import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { sendActivation, ensureActivationToken } from "@/lib/migrationServer";
import { MIGRATION_STATUS } from "@/lib/migration";

// Cap per request so thousands of members send in safe batches. The UI loops
// until `remaining` is 0, showing progress. Capped by FAMILY now (one invite
// per guardian), so this bounds the number of emails per request.
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

  // ── FAMILY GROUPING ──
  // A guardian gets ONE onboarding email for their whole family. Group the
  // target members by guardian email (minors only); each adult / unique-email
  // member is its own group. We email the family's representative once and make
  // sure every sibling has a valid token so the activation page can walk the
  // guardian through "set up the next athlete" without extra emails.
  const targets = await prisma.member.findMany({
    where: { id: { in: targetIds }, clubId, deletedAt: null },
    select: { id: true, isMinor: true, guardianEmail: true, migrationStatus: true, importedAt: true },
  });
  const statusById = new Map(targets.map((t) => [t.id, t.migrationStatus]));
  const familyMap = new Map<string, string[]>();
  for (const t of targets) {
    const key = t.isMinor && t.guardianEmail ? `g:${t.guardianEmail.toLowerCase()}` : `m:${t.id}`;
    const list = familyMap.get(key) ?? [];
    list.push(t.id);
    familyMap.set(key, list);
  }
  const families = [...familyMap.entries()].map(([key, ids]) => ({ key, ids }));

  // One "unit" = one family. Cap the number of families (≈ emails) per request.
  const batchFams = families.slice(0, BATCH_CAP);
  const processedMembers = batchFams.reduce((a, f) => a + f.ids.length, 0);
  const remaining = Math.max(0, targetIds.length - processedMembers);

  let sent = 0; // emails actually sent (one per family)
  let membersInvited = 0; // siblings given a token without a separate email
  let failed = 0;
  const errors: string[] = [];

  for (const fam of batchFams) {
    const guardianEmail = fam.key.startsWith("g:") ? fam.key.slice(2) : null;
    let repSent = false;
    for (const mid of fam.ids) {
      if (statusById.get(mid) === MIGRATION_STATUS.COMPLETED) continue;
      if (!repSent) {
        const r = await sendActivation(mid, clubId, session.user.id, body.reminder);
        if (r.ok) {
          sent++;
          repSent = true;
        } else {
          failed++;
          if (errors.length < 20) errors.push(`${mid}: ${r.reason}`);
        }
      } else {
        const t = await ensureActivationToken(mid, clubId, session.user.id);
        if (t.ok) membersInvited++;
      }
    }
    // Whole-family coverage: ensure EVERY pending minor sibling of this guardian
    // (even ones not in the selected/target set) has a token, so the single
    // invite truly covers the family.
    if (guardianEmail && repSent) {
      const siblings = await prisma.member.findMany({
        where: {
          clubId,
          deletedAt: null,
          isMinor: true,
          guardianEmail: { equals: guardianEmail, mode: "insensitive" },
          id: { notIn: fam.ids },
          migrationStatus: {
            in: [MIGRATION_STATUS.IMPORTED, MIGRATION_STATUS.INVITED, MIGRATION_STATUS.NEEDS_REVIEW],
          },
        },
        select: { id: true },
      });
      for (const s of siblings) {
        const t = await ensureActivationToken(s.id, clubId, session.user.id);
        if (t.ok) membersInvited++;
      }
    }
  }

  return NextResponse.json({
    ok: true,
    sent,
    membersInvited,
    failed,
    remaining,
    processed: processedMembers,
    families: batchFams.length,
    errors,
  });
}
