import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { formatZodError } from "@/lib/zodErrors";
import { requirePermissionLive } from "@/lib/apiGuard";
import { requireTierFeature } from "@/lib/tierGuard";
import { ledgerActor } from "@/lib/ledgerGuard";
import { rateLimit, rateLimitedResponse } from "@/lib/ratelimit";
import {
  LedgerError,
  accountBalances,
  createAccount,
  ensureChartOfAccounts,
  ensureSystemAccounts,
  listAccounts,
  signedBalanceCents,
} from "@/lib/ledgerServer";

export const dynamic = "force-dynamic";

// GET /api/financials/ledger/accounts — the chart of accounts, with each
// account's posting count and its balance. finances:view, Pro+.
//
// SEEDS ON FIRST READ. `ensureChartOfAccounts` returns immediately once the
// club has any account, so this is a no-op on every subsequent load — but it is
// what makes "new eligible clubs get the template automatically" true without a
// cron job or a migration backfill. The tier gate has already run, so a Starter
// club never reaches it and never gets a chart it can't use.
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
  const actor = ledgerActor(session);

  const url = new URL(req.url);
  const from = url.searchParams.get("from") ?? undefined;
  const to = url.searchParams.get("to") ?? undefined;
  const legalEntityId = url.searchParams.get("entity") ?? undefined;

  const seeded = await ensureChartOfAccounts(clubId, actor);
  // Additive top-up for clubs seeded before the template gained a system
  // account (1020 Undeposited Funds, 2026-10-20). A no-op once they have it.
  const topUp = await ensureSystemAccounts(clubId, actor);
  const [accounts, balances] = await Promise.all([
    listAccounts(clubId),
    accountBalances(clubId, {
      from,
      to,
      legalEntityId: legalEntityId && legalEntityId !== "all" ? legalEntityId : undefined,
    }),
  ]);

  return NextResponse.json({
    accounts: accounts.map((a) => {
      const t = balances.get(a.id);
      return {
        ...a,
        debitCents: t?.debitCents ?? 0,
        creditCents: t?.creditCents ?? 0,
        // Signed in the account's own normal direction, so the UI never has to
        // re-derive which way is "more".
        balanceCents: signedBalanceCents(a.normalBalance, t),
      };
    }),
    seeded: seeded.seeded,
    addedSystemAccounts: topUp.added,
  });
}

const createSchema = z
  .object({
    number: z.string().trim().min(1).max(20),
    name: z.string().trim().min(1).max(120),
    type: z.enum(["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"]),
    subtype: z.string().trim().max(40).nullable().optional(),
    normalBalance: z.enum(["DEBIT", "CREDIT"]).optional(),
    isContra: z.boolean().optional(),
    parentId: z.string().min(1).nullable().optional(),
    description: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

// POST /api/financials/ledger/accounts — add an account. finances:edit, Pro+.
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

  const rl = rateLimit({ key: `gl:accounts:${actor.userId ?? clubId}`, limit: 30, windowMs: 60_000 });
  if (!rl.allowed) return rateLimitedResponse(rl, "Too many changes at once. Wait a moment and try again.");

  let data: z.infer<typeof createSchema>;
  try {
    data = createSchema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  try {
    const account = await createAccount(clubId, data, actor);
    return NextResponse.json({ account });
  } catch (err) {
    if (err instanceof LedgerError) {
      return NextResponse.json({ error: err.message, details: err.details }, { status: err.status });
    }
    throw err;
  }
}
