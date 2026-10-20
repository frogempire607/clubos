import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { formatZodError } from "@/lib/zodErrors";
import { requireOwnerLive, requirePermissionLive } from "@/lib/apiGuard";
import { requireTierFeature } from "@/lib/tierGuard";
import { ledgerActor } from "@/lib/ledgerGuard";
import { LedgerError, listLockDates, setLockDate } from "@/lib/ledgerServer";

export const dynamic = "force-dynamic";

// GET /api/financials/ledger/lock-dates — one lock date per legal entity.
// finances:view, Pro+ (reading it is not an owner-only act; changing it is).
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "finances", "view");
  if (denied) return denied;
  // Tier gate (pricing overhaul 2026-10-18) — enforced server-side, last so a
  // staffer without finance permission hears that, not "upgrade your plan".
  const tierGate = await requireTierFeature(session.user.clubId, "fullFinancials");
  if (tierGate) return tierGate;
  const clubId = session.user.clubId;
  return NextResponse.json({ lockDates: await listLockDates(clubId) });
}

const schema = z
  .object({
    legalEntityId: z.string().min(1),
    // null REMOVES the lock entirely, which is a deliberate, audited act —
    // not the same as omitting the field.
    lockedThrough: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    note: z.string().trim().max(300).nullable().optional(),
  })
  .strict();

// PUT /api/financials/ledger/lock-dates — set or clear one entity's lock date.
// OWNER ONLY, Pro+.
//
// Owner-only because the lock date is the control that stops everyone else
// editing closed history, so it cannot be delegated through a permission level.
// Every change is audited, INCLUDING moving a lock backwards — the audit note
// says so in as many words, because reopening a closed period is exactly what
// an auditor asks about.
export async function PUT(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // OWNER ONLY. The lock date is the control that stops everyone else editing
  // closed history, so it is not delegated through a permission level.
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

  try {
    const lockDates = await setLockDate(
      clubId,
      data.legalEntityId,
      data.lockedThrough,
      data.note ?? null,
      actor,
    );
    return NextResponse.json({ lockDates });
  } catch (err) {
    if (err instanceof LedgerError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
