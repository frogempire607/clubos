import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requirePermissionLive } from "@/lib/apiGuard";
import { importPreview, saveMapping } from "@/lib/ledgerImportServer";
import type { ImportMapping } from "@/lib/ledgerImport";
import { requireTierFeature } from "@/lib/tierGuard";

export const dynamic = "force-dynamic";

// GET /api/financials/imports/[id] — the plan: what each QuickBooks row will
// do (match / add as history / skip, and why). Writes nothing. finances:full.
export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "finances", "full");
  if (denied) return denied;
  // Tier gate (pricing overhaul 2026-10-18) — enforced server-side.
  const tierGate = await requireTierFeature(session.user.clubId, "fullFinancials");
  if (tierGate) return tierGate;
  const pv = await importPreview(session.user.clubId, id);
  if (!pv) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(pv);
}

const accountMap = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("BANK"), bankAccountId: z.string().min(1) }),
  z.object({ kind: z.literal("CATEGORY"), category: z.string().max(40).nullable() }),
  z.object({ kind: z.literal("SKIP") }),
]);
const schema = z.object({
  mapping: z.object({
    accounts: z.record(z.string(), accountMap),
    types: z.record(z.string(), z.enum(["IN", "OUT", "TRANSFER", "SKIP", "AUTO"])),
  }),
}).strict();

// PATCH /api/financials/imports/[id]  { mapping } — a DRAFT's mapping. finances:full.
export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "finances", "full");
  if (denied) return denied;
  // Tier gate (pricing overhaul 2026-10-18) — enforced server-side.
  const tierGate = await requireTierFeature(session.user.clubId, "fullFinancials");
  if (tierGate) return tierGate;
  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid mapping" }, { status: 400 });
  }
  const ok = await saveMapping(session.user.clubId, id, body.mapping as ImportMapping);
  if (!ok) return NextResponse.json({ error: "This import can't be changed (already committed, or a bank account isn't this club's)." }, { status: 409 });
  return NextResponse.json({ ok: true });
}
