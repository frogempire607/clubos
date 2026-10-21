import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { formatZodError } from "@/lib/zodErrors";
import { requireOwnerLive, requirePermissionLive } from "@/lib/apiGuard";
import { requireTierFeature } from "@/lib/tierGuard";
import { ledgerActor } from "@/lib/ledgerGuard";
import { isValidDateOnly } from "@/lib/ledger";

export const dynamic = "force-dynamic";

const toDateStr = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

// GET /api/financials/ledger/books-start — finances:view, Pro+.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "finances", "view");
  if (denied) return denied;
  const tierGate = await requireTierFeature(session.user.clubId, "fullFinancials");
  if (tierGate) return tierGate;

  const club = await prisma.club.findUnique({
    where: { id: session.user.clubId },
    select: { booksStartDate: true },
  });
  return NextResponse.json({ booksStartDate: toDateStr(club?.booksStartDate ?? null) });
}

const schema = z
  .object({
    // null CLEARS it, which stops automatic posting. That is a deliberate,
    // audited act — not the same as omitting the field.
    booksStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  })
  .strict();

// PUT /api/financials/ledger/books-start — OWNER ONLY, Pro+.
//
// The date automatic posting begins. Nothing dated before it ever posts
// automatically, which is what stops Phase 2 double-counting history the club
// already imported. NULL means "not configured" and automatic posting does not
// run at all — never "post everything".
//
// Owner-only for the same reason the lock date is: it decides which periods the
// books are allowed to touch, so it cannot be delegated through a permission
// level. Every change is audited, including moving it later (which stops rows
// posting) and earlier (which lets older rows in).
export async function PUT(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requireOwnerLive(session);
  if (denied) return denied;
  const tierGate = await requireTierFeature(session.user.clubId, "fullFinancials");
  if (tierGate) return tierGate;
  const clubId = session.user.clubId;
  const actor = ledgerActor(session);

  let data: z.infer<typeof schema>;
  try {
    data = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  if (data.booksStartDate !== null && !isValidDateOnly(data.booksStartDate)) {
    return NextResponse.json({ error: "Pick a real date (YYYY-MM-DD)." }, { status: 400 });
  }

  const before = await prisma.club.findUnique({ where: { id: clubId }, select: { booksStartDate: true } });
  const beforeStr = toDateStr(before?.booksStartDate ?? null);
  const after = data.booksStartDate;

  await prisma.$transaction(async (tx) => {
    await tx.club.updateMany({
      where: { id: clubId },
      data: { booksStartDate: after === null ? null : new Date(`${after}T00:00:00.000Z`) },
    });
    const moved =
      beforeStr && after
        ? after < beforeStr
          ? " This moved it EARLIER, so older records can now post."
          : after > beforeStr
            ? " This moved it LATER, so records before the new date will stop posting."
            : ""
        : "";
    await tx.glAuditLog.create({
      data: {
        clubId,
        objectType: "LOCK_DATE",
        objectId: "books-start-date",
        action: beforeStr ? "UPDATE" : "CREATE",
        actorUserId: actor.userId,
        actorName: actor.name,
        before: { booksStartDate: beforeStr },
        after: { booksStartDate: after },
        note:
          after === null
            ? "Cleared the books start date — automatic posting is off until one is set."
            : `Books start ${after}.${moved}`,
      },
    });
  });

  return NextResponse.json({ booksStartDate: after });
}
