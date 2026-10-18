import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requirePermissionLive } from "@/lib/apiGuard";
import { createImportDraft, listImports } from "@/lib/ledgerImportServer";
import { requireTierFeature } from "@/lib/tierGuard";

export const dynamic = "force-dynamic";
const MAX_BYTES = 8 * 1024 * 1024;

// GET /api/financials/imports — past QuickBooks imports (finances:full).
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "finances", "full");
  if (denied) return denied;
  // Tier gate (pricing overhaul 2026-10-18) — enforced server-side.
  const tierGate = await requireTierFeature(session.user.clubId, "fullFinancials");
  if (tierGate) return tierGate;
  return NextResponse.json({ imports: await listImports(session.user.clubId) });
}

// POST /api/financials/imports (multipart: file) — read a QuickBooks CSV /
// Excel export into a DRAFT. Nothing is written to the books until commit.
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "finances", "full");
  if (denied) return denied;
  // Tier gate (pricing overhaul 2026-10-18) — enforced server-side.
  const tierGate = await requireTierFeature(session.user.clubId, "fullFinancials");
  if (tierGate) return tierGate;
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Choose the QuickBooks export file." }, { status: 400 });
  if (file.size <= 0 || file.size > MAX_BYTES) return NextResponse.json({ error: "The file must be under 8 MB." }, { status: 400 });
  if (!/\.(csv|xlsx)$/i.test(file.name)) return NextResponse.json({ error: "Use a .csv or .xlsx export from QuickBooks." }, { status: 400 });
  try {
    const r = await createImportDraft({
      clubId: session.user.clubId, userId: session.user.id ?? null, fileName: file.name, buf: Buffer.from(await file.arrayBuffer()),
    });
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
    return NextResponse.json({ ok: true, id: r.id }, { status: 201 });
  } catch (e) {
    console.error("import draft failed", e);
    return NextResponse.json({ error: "That file couldn't be read. Export it again as CSV and retry." }, { status: 400 });
  }
}
