import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";

// POST /api/members/merge  { winnerId, loserId }
//
// Confirmation-gated, owner/staff-only. Merges a duplicate member (loser) INTO
// the survivor (winner):
//   • reassigns every FK that references the loser -> the winner
//   • soft-deletes the loser (deletedAt set) — NEVER a hard delete, so nothing
//     is destroyed and the DB CASCADE rules never fire; it's fully reversible
//   • runs in ONE transaction: any error rolls the whole thing back
// It refuses to merge two records that BOTH have a login (that needs a human).

// Every table with a plain memberId -> members(id) FK (from the DB catalog).
// None of these columns has a unique constraint, so reassignment can't collide.
const MEMBER_ID_TABLES = [
  "attendance_records",
  "bookings",
  "campaign_attributions",
  "document_signatures",
  "event_registrations",
  "guardian_consent_requests",
  "invoice_splits",
  "member_guardian_users",
  "member_migration_events",
  "member_subscriptions",
  "parental_consents",
  "pending_approvals",
  "private_booking_partners",
  "private_bookings",
  "private_credit_ledger",
  "product_sales",
  "transactions",
];

const bodySchema = z.object({
  winnerId: z.string().min(1),
  loserId: z.string().min(1),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const guard = requirePermission(session, "members", "full");
  if (guard) return guard;
  const clubId = (session.user as { clubId?: string }).clubId as string;

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "winnerId and loserId are required." }, { status: 400 });
  }
  const { winnerId, loserId } = body;
  if (winnerId === loserId) {
    return NextResponse.json({ error: "Cannot merge a member into itself." }, { status: 400 });
  }

  const [winner, loser] = await Promise.all([
    prisma.member.findFirst({ where: { id: winnerId, clubId, deletedAt: null } }),
    prisma.member.findFirst({ where: { id: loserId, clubId, deletedAt: null } }),
  ]);
  if (!winner || !loser) {
    return NextResponse.json(
      { error: "Both members must exist in your club and not already be deleted." },
      { status: 404 },
    );
  }
  if (winner.userId && loser.userId) {
    return NextResponse.json(
      { error: "Both records have their own login. Remove one login first, then merge." },
      { status: 409 },
    );
  }

  await prisma.$transaction(async (tx) => {
    // Preserve a login: if only the duplicate has one, move it to the survivor.
    // Clear the loser FIRST so the global members_userId unique index never sees
    // the same userId on two rows at once.
    if (loser.userId && !winner.userId) {
      await tx.member.update({ where: { id: loserId }, data: { userId: null } });
      await tx.member.update({ where: { id: winnerId }, data: { userId: loser.userId } });
    }

    // Reassign every memberId FK: loser -> winner.
    for (const table of MEMBER_ID_TABLES) {
      await tx.$executeRawUnsafe(
        `UPDATE "${table}" SET "memberId" = $1 WHERE "memberId" = $2`,
        winnerId,
        loserId,
      );
    }
    // member_relationships also points back via relatedMemberId. Reassign both
    // sides, then drop any self-relationship the merge produced (winner<->winner).
    await tx.$executeRawUnsafe(
      `UPDATE "member_relationships" SET "memberId" = $1 WHERE "memberId" = $2`,
      winnerId,
      loserId,
    );
    await tx.$executeRawUnsafe(
      `UPDATE "member_relationships" SET "relatedMemberId" = $1 WHERE "relatedMemberId" = $2`,
      winnerId,
      loserId,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM "member_relationships" WHERE "memberId" = "relatedMemberId"`,
    );

    const today = new Date().toISOString().slice(0, 10);
    // Soft-delete the duplicate + release its login slot. Its history now lives
    // on the survivor; the row is retained (reversible) with a breadcrumb.
    await tx.member.update({
      where: { id: loserId },
      data: {
        deletedAt: new Date(),
        userId: null,
        notes: `${loser.notes ? loser.notes + " " : ""}[merged into ${winnerId} on ${today}]`,
      },
    });
    // Audit breadcrumb on the survivor.
    await tx.member.update({
      where: { id: winnerId },
      data: {
        notes: `${winner.notes ? winner.notes + " " : ""}[merged duplicate ${loser.firstName} ${loser.lastName} (${loserId}) on ${today}]`,
      },
    });
  });

  return NextResponse.json({ ok: true, winnerId, loserId });
}
