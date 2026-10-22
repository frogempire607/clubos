import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { formatZodError } from "@/lib/zodErrors";
import { requirePermissionLive } from "@/lib/apiGuard";
import { requireTierFeature } from "@/lib/tierGuard";
import { ledgerActor } from "@/lib/ledgerGuard";
import { LedgerError } from "@/lib/ledgerServer";
import { loadOpeningImport, postOpeningImport, saveOpeningMapping, voidOpeningImport } from "@/lib/glOpeningServer";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET /api/financials/ledger/opening/[id]?entity= — the parsed trial balance,
// the mapping, the planned entry, and every reason it can't post yet.
// finances:full, Pro+.
export async function GET(req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "finances", "full");
  if (denied) return denied;
  const tierGate = await requireTierFeature(session.user.clubId, "fullFinancials");
  if (tierGate) return tierGate;

  const entity = new URL(req.url).searchParams.get("entity");
  try {
    const view = await loadOpeningImport(session.user.clubId, params.id, {
      legalEntityId: entity && entity !== "all" ? entity : null,
    });
    return NextResponse.json({ import: view });
  } catch (err) {
    if (err instanceof LedgerError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}

const mappingSchema = z
  .object({
    action: z.literal("mapping"),
    // QuickBooks account name → AthletixOS account id, or null to skip it.
    mapping: z.record(z.string().min(1).nullable()),
  })
  .strict();

const postSchema = z
  .object({
    action: z.literal("post"),
    legalEntityId: z.string().min(1).nullable(),
  })
  .strict();

const voidSchema = z
  .object({
    action: z.literal("void"),
    reason: z.string().trim().min(5).max(500),
  })
  .strict();

// PATCH /api/financials/ledger/opening/[id] — save the mapping, post the
// entry, or void a posted import. finances:full, Pro+.
//
// One route for the three because they are three things you do to this one
// import, and one permission check and one tier gate is better than three of
// each.
export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "finances", "full");
  if (denied) return denied;
  const tierGate = await requireTierFeature(session.user.clubId, "fullFinancials");
  if (tierGate) return tierGate;

  const body = await req.json().catch(() => null);
  const action = (body as { action?: string } | null)?.action;
  const clubId = session.user.clubId;

  try {
    if (action === "mapping") {
      const parsed = mappingSchema.safeParse(body);
      if (!parsed.success) return NextResponse.json(formatZodError(parsed.error), { status: 400 });
      await saveOpeningMapping(clubId, params.id, parsed.data.mapping);
    } else if (action === "post") {
      const parsed = postSchema.safeParse(body);
      if (!parsed.success) return NextResponse.json(formatZodError(parsed.error), { status: 400 });
      const result = await postOpeningImport(clubId, params.id, parsed.data.legalEntityId, ledgerActor(session));
      const view = await loadOpeningImport(clubId, params.id, { legalEntityId: parsed.data.legalEntityId });
      return NextResponse.json({ ...result, import: view });
    } else if (action === "void") {
      const parsed = voidSchema.safeParse(body);
      if (!parsed.success) return NextResponse.json(formatZodError(parsed.error), { status: 400 });
      await voidOpeningImport(clubId, params.id, parsed.data.reason, ledgerActor(session));
    } else {
      return NextResponse.json({ error: "Unknown action. Use mapping, post or void." }, { status: 400 });
    }
    const view = await loadOpeningImport(clubId, params.id);
    return NextResponse.json({ import: view });
  } catch (err) {
    if (err instanceof LedgerError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
