import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requirePermissionLive } from "@/lib/apiGuard";
import { requireTierFeature } from "@/lib/tierGuard";
import { ledgerActor } from "@/lib/ledgerGuard";
import { LedgerError } from "@/lib/ledgerServer";
import { createOpeningDraft, listOpeningImports } from "@/lib/glOpeningServer";

export const dynamic = "force-dynamic";
// A trial balance is small, but exceljs parsing plus a cold Lambda is not
// instant.
export const maxDuration = 60;
const MAX_BYTES = 8 * 1024 * 1024;

// GET /api/financials/ledger/opening — past opening-balance imports.
// finances:full, Pro+ (this is the screen that writes the club's opening
// position, so view-only access is not enough to be here).
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "finances", "full");
  if (denied) return denied;
  const tierGate = await requireTierFeature(session.user.clubId, "fullFinancials");
  if (tierGate) return tierGate;
  return NextResponse.json({ imports: await listOpeningImports(session.user.clubId) });
}

// POST /api/financials/ledger/opening (multipart: file) — read a QuickBooks
// Trial Balance into a DRAFT with a suggested mapping. NOTHING is posted here.
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "finances", "full");
  if (denied) return denied;
  const tierGate = await requireTierFeature(session.user.clubId, "fullFinancials");
  if (tierGate) return tierGate;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Choose the QuickBooks trial balance file." }, { status: 400 });
  }
  if (file.size <= 0 || file.size > MAX_BYTES) {
    return NextResponse.json({ error: "The file must be under 8 MB." }, { status: 400 });
  }
  if (!/\.(csv|xlsx)$/i.test(file.name)) {
    return NextResponse.json({ error: "Use a .csv or .xlsx export from QuickBooks." }, { status: 400 });
  }

  try {
    const id = await createOpeningDraft(
      session.user.clubId,
      file.name,
      Buffer.from(await file.arrayBuffer()),
      ledgerActor(session),
    );
    return NextResponse.json({ id }, { status: 201 });
  } catch (err) {
    if (err instanceof LedgerError) return NextResponse.json({ error: err.message }, { status: err.status });
    console.error("opening balance draft failed", err);
    return NextResponse.json(
      { error: "That file couldn't be read. Export the trial balance again as CSV and retry." },
      { status: 400 },
    );
  }
}
