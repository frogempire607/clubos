import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { formatZodError } from "@/lib/zodErrors";
import { requirePermissionLive } from "@/lib/apiGuard";
import { requireTierFeature } from "@/lib/tierGuard";
import { ledgerActor } from "@/lib/ledgerGuard";
import { rateLimit, rateLimitedResponse } from "@/lib/ratelimit";
import { LedgerError, createEntry, listEntries } from "@/lib/ledgerServer";

export const dynamic = "force-dynamic";

// GET /api/financials/ledger/entries — the journal. finances:view, Pro+.
// Filters: ?from= &to= &entity= &account= &status= &q= &take= &skip=
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "finances", "view");
  if (denied) return denied;
  // Tier gate (pricing overhaul 2026-10-18) — enforced server-side, last so a
  // staffer without finance permission hears that, not "upgrade your plan".
  const tierGate = await requireTierFeature(session.user.clubId, "fullFinancials");
  if (tierGate) return tierGate;
  const clubId = session.user.clubId;

  const p = new URL(req.url).searchParams;
  const entity = p.get("entity");
  const account = p.get("account");
  const result = await listEntries(clubId, {
    from: p.get("from") ?? undefined,
    to: p.get("to") ?? undefined,
    legalEntityId: entity && entity !== "all" ? entity : undefined,
    accountId: account && account !== "all" ? account : undefined,
    status: p.get("status") ?? "POSTED",
    q: p.get("q") ?? undefined,
    take: p.get("take") ? Number(p.get("take")) : undefined,
    skip: p.get("skip") ? Number(p.get("skip")) : undefined,
  });
  return NextResponse.json(result);
}

// Amounts cross the wire as INTEGER CENTS, matching storage. The client does
// the dollars→cents conversion with lib/ledger parseDollarsToCents so one
// rounding rule applies on both sides; a float here would reintroduce exactly
// the drift integer cents exist to prevent.
const lineSchema = z
  .object({
    accountId: z.string().min(1),
    debitCents: z.number().int().min(0).max(2_000_000_000).default(0),
    creditCents: z.number().int().min(0).max(2_000_000_000).default(0),
    legalEntityId: z.string().min(1).nullable().optional(),
    program: z.string().trim().max(80).nullable().optional(),
    memo: z.string().trim().max(300).nullable().optional(),
    memberId: z.string().min(1).nullable().optional(),
  })
  .strict();

const createSchema = z
  .object({
    entryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    memo: z.string().trim().max(500).nullable().optional(),
    reference: z.string().trim().max(80).nullable().optional(),
    legalEntityId: z.string().min(1).nullable().optional(),
    // 2..200 lines. The floor is the double-entry rule itself; the ceiling
    // stops a single request writing an unbounded number of rows.
    lines: z.array(lineSchema).min(2).max(200),
  })
  .strict();

// POST /api/financials/ledger/entries — post a manual journal entry.
// finances:edit, Pro+.
//
// EVERY RULE IS ENFORCED IN lib/ledgerServer.createEntry, not here: debits must
// equal credits, no line may carry both a debit and a credit, the total may not
// be zero, and the date may not fall on or before the lock date of any entity
// the entry touches. This route only shapes the request and maps the refusal
// onto a status code.
//
// `sourceType` is NOT accepted from the client. Everything posted here is
// MANUAL; Phase 2's automatic posting calls the service directly, and letting a
// client claim sourceType "STRIPE_CHARGE" would let it occupy the
// (clubId, sourceType, sourceId) slot that makes automatic posting idempotent.
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "finances", "edit");
  if (denied) return denied;
  // Tier gate (pricing overhaul 2026-10-18) — enforced server-side, last so a
  // staffer without finance permission hears that, not "upgrade your plan".
  const tierGate = await requireTierFeature(session.user.clubId, "fullFinancials");
  if (tierGate) return tierGate;
  const clubId = session.user.clubId;
  const actor = ledgerActor(session);

  const rl = rateLimit({ key: `gl:entries:${actor.userId ?? clubId}`, limit: 60, windowMs: 60_000 });
  if (!rl.allowed) return rateLimitedResponse(rl, "Too many entries at once. Wait a moment and try again.");

  let data: z.infer<typeof createSchema>;
  try {
    data = createSchema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  try {
    const entry = await createEntry(
      clubId,
      {
        entryDate: data.entryDate,
        memo: data.memo ?? null,
        reference: data.reference ?? null,
        legalEntityId: data.legalEntityId ?? null,
        sourceType: "MANUAL",
        sourceId: null,
        lines: data.lines,
      },
      actor,
    );
    return NextResponse.json({ entry });
  } catch (err) {
    if (err instanceof LedgerError) {
      return NextResponse.json({ error: err.message, details: err.details }, { status: err.status });
    }
    throw err;
  }
}
