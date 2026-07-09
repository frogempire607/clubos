import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";

// POST /api/members/merge  { winnerId, loserId, fields? }
//
// Confirmation-gated, owner/staff-only. Merges a duplicate member (loser) INTO
// the survivor (winner):
//   • reassigns every FK that references the loser -> the winner
//   • soft-deletes the loser (deletedAt set) — NEVER a hard delete, so nothing
//     is destroyed and the DB CASCADE rules never fire; it's fully reversible
//   • runs in ONE transaction: any error rolls the whole thing back
// It refuses to merge two records that BOTH have a login (that needs a human).
//
// `fields` is the owner's per-field pick from the merge preview: a map of
// profile column -> "winner" | "loser". Only whitelisted columns are accepted,
// and the VALUE is always read server-side from the loser row — the client can
// choose which record's value survives but can never inject a new one. Omitted
// fields (and "winner" picks) keep the survivor's value untouched.
//
// Data preservation: memberships, transactions, attendance, private lessons,
// approvals, migration history, etc. all move to the winner. For the handful of
// tables with a UNIQUE constraint on (someId, memberId) — bookings, document
// signatures, guardian links, relationships — a loser row that would DUPLICATE
// an existing winner row (same event, same document, same guardian) is dropped
// first so the reassignment can't hit a unique violation; the winner's
// equivalent row is kept, so no distinct information is lost. Messages "about"
// the loser child (messages.subjectMemberId) are repointed to the winner.

// Tables with a plain memberId -> members(id) FK and NO unique constraint on
// memberId: a straight bulk reassignment can never collide.
const SAFE_MEMBER_ID_TABLES = [
  "attendance_records",
  "campaign_attributions",
  "event_registrations",
  "guardian_consent_requests",
  "invoice_splits",
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

// Tables with a UNIQUE constraint (otherCol, memberId): drop the loser's
// colliding rows first, then reassign the rest.
const UNIQUE_MEMBER_ID_TABLES: { table: string; otherCol: string }[] = [
  { table: "bookings", otherCol: "eventId" },
  { table: "document_signatures", otherCol: "documentId" },
  { table: "member_guardian_users", otherCol: "userId" },
];

// Profile columns the owner may pick per-record in the merge preview. Nothing
// billing- or identity-critical is here (no userId, no stripe ids, no status).
const MERGEABLE_FIELDS = [
  "firstName",
  "lastName",
  "dateOfBirth",
  "email",
  "phone",
  "streetAddress",
  "city",
  "state",
  "zipCode",
  "gender",
  "guardianName",
  "guardianEmail",
  "guardianPhone",
  "guardianRelationship",
] as const;
type MergeableField = (typeof MERGEABLE_FIELDS)[number];

const bodySchema = z.object({
  winnerId: z.string().min(1),
  loserId: z.string().min(1),
  // Keys are validated against MERGEABLE_FIELDS below (z.record with an enum
  // key infers an all-keys-required type in zod 3, which is not what we want).
  fields: z.record(z.enum(["winner", "loser"])).optional(),
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

  // Owner's per-field picks from the preview: for every whitelisted field
  // marked "loser", the duplicate's value is carried onto the survivor. Values
  // come from the loser row we just loaded — never from the request body.
  // Values are column-for-column copies off the loser row, so the shape is
  // correct per column even though TS only sees the cross-field union here.
  const fieldCarry: Partial<Record<MergeableField, string | Date | null>> = {};
  for (const [field, choice] of Object.entries(body.fields ?? {})) {
    if (!(MERGEABLE_FIELDS as readonly string[]).includes(field)) {
      return NextResponse.json({ error: `"${field}" is not a mergeable field.` }, { status: 400 });
    }
    if (choice === "loser") {
      fieldCarry[field as MergeableField] = loser[field as MergeableField];
    }
  }

  await prisma.$transaction(async (tx) => {
    // Preserve a login: if only the duplicate has one, move it to the survivor.
    // Clear the loser FIRST so the global members_userId unique index never sees
    // the same userId on two rows at once.
    if (loser.userId && !winner.userId) {
      await tx.member.update({ where: { id: loserId }, data: { userId: null } });
      await tx.member.update({ where: { id: winnerId }, data: { userId: loser.userId } });
    }

    // Reassign every no-unique memberId FK: loser -> winner.
    for (const table of SAFE_MEMBER_ID_TABLES) {
      await tx.$executeRawUnsafe(
        `UPDATE "${table}" SET "memberId" = $1 WHERE "memberId" = $2`,
        winnerId,
        loserId,
      );
    }

    // Unique-constrained tables: drop the loser's rows that would collide with an
    // existing winner row on the unique key, then reassign what remains.
    for (const { table, otherCol } of UNIQUE_MEMBER_ID_TABLES) {
      await tx.$executeRawUnsafe(
        `DELETE FROM "${table}" WHERE "memberId" = $1 AND "${otherCol}" IN (SELECT "${otherCol}" FROM "${table}" WHERE "memberId" = $2)`,
        loserId,
        winnerId,
      );
      await tx.$executeRawUnsafe(
        `UPDATE "${table}" SET "memberId" = $1 WHERE "memberId" = $2`,
        winnerId,
        loserId,
      );
    }

    // Messages "about" the loser child (scalar subjectMemberId, no FK) follow the
    // survivor so a guardian↔coach thread scoped to the merged child still resolves.
    await tx.$executeRawUnsafe(
      `UPDATE "messages" SET "subjectMemberId" = $1 WHERE "subjectMemberId" = $2`,
      winnerId,
      loserId,
    );

    // member_relationships points back via BOTH memberId and relatedMemberId, with
    // a unique on (memberId, relatedMemberId). Drop the loser's colliding rows on
    // each side, reassign the rest, then remove any self-relationship produced.
    await tx.$executeRawUnsafe(
      `DELETE FROM "member_relationships" WHERE "memberId" = $1 AND "relatedMemberId" IN (SELECT "relatedMemberId" FROM "member_relationships" WHERE "memberId" = $2)`,
      loserId,
      winnerId,
    );
    await tx.$executeRawUnsafe(
      `UPDATE "member_relationships" SET "memberId" = $1 WHERE "memberId" = $2`,
      winnerId,
      loserId,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM "member_relationships" WHERE "relatedMemberId" = $1 AND "memberId" IN (SELECT "memberId" FROM "member_relationships" WHERE "relatedMemberId" = $2)`,
      loserId,
      winnerId,
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
    // Audit breadcrumb on the survivor + the owner's field picks (values read
    // from the loser row above).
    await tx.member.update({
      where: { id: winnerId },
      data: {
        ...(fieldCarry as Prisma.MemberUncheckedUpdateInput),
        notes: `${winner.notes ? winner.notes + " " : ""}[merged duplicate ${loser.firstName} ${loser.lastName} (${loserId}) on ${today}]`,
      },
    });
  });

  return NextResponse.json({ ok: true, winnerId, loserId });
}
