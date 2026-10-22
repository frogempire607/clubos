import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requirePermissionLive } from "@/lib/apiGuard";
import { requireTierFeature } from "@/lib/tierGuard";
import { ledgerActor } from "@/lib/ledgerGuard";
import { LedgerError } from "@/lib/ledgerServer";
import {
  deleteHistoryFile,
  importHistory,
  listHistoryFiles,
  searchHistory,
  type HistoryKind,
} from "@/lib/glOpeningServer";

export const dynamic = "force-dynamic";
// A year's general ledger is tens of thousands of rows, inserted in chunks.
export const maxDuration = 60;
const MAX_BYTES = 16 * 1024 * 1024;

// GET /api/financials/ledger/history?q=&account=&from=&to=&file=&take=&skip=
// — the READ-ONLY QuickBooks archive. finances:view, Pro+.
//
// ⚠️  These rows never post, never appear in a statement, and no balance is
// derived from them. The guarantee is structural: qbo_history_rows has no
// relation to any gl_* table, and scripts/gl-opening-tests.ts greps the
// reports and posting modules on every build to prove neither reads it.
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "finances", "view");
  if (denied) return denied;
  const tierGate = await requireTierFeature(session.user.clubId, "fullFinancials");
  if (tierGate) return tierGate;
  const clubId = session.user.clubId;

  const p = new URL(req.url).searchParams;
  const [files, results] = await Promise.all([
    listHistoryFiles(clubId),
    searchHistory(clubId, {
      q: p.get("q"),
      account: p.get("account"),
      from: p.get("from"),
      to: p.get("to"),
      fileId: p.get("file"),
      take: p.get("take") ? Number(p.get("take")) : undefined,
      skip: p.get("skip") ? Number(p.get("skip")) : undefined,
    }),
  ]);
  return NextResponse.json({ files, ...results });
}

const KINDS: HistoryKind[] = ["GENERAL_LEDGER", "TRANSACTION_DETAIL", "OTHER"];

// POST /api/financials/ledger/history (multipart: file, kind?, notes?) —
// archive a QuickBooks General Ledger or Transaction Detail by Account export.
// finances:full, Pro+.
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
    return NextResponse.json({ error: "Choose the QuickBooks export file." }, { status: 400 });
  }
  if (file.size <= 0 || file.size > MAX_BYTES) {
    return NextResponse.json({ error: "The file must be under 16 MB." }, { status: 400 });
  }
  if (!/\.(csv|xlsx)$/i.test(file.name)) {
    return NextResponse.json({ error: "Use a .csv or .xlsx export from QuickBooks." }, { status: 400 });
  }
  const kindRaw = String(form.get("kind") ?? "GENERAL_LEDGER");
  const kind = (KINDS as string[]).includes(kindRaw) ? (kindRaw as HistoryKind) : "OTHER";
  const notes = form.get("notes");

  try {
    const result = await importHistory(
      session.user.clubId,
      file.name,
      Buffer.from(await file.arrayBuffer()),
      kind,
      ledgerActor(session),
      { notes: typeof notes === "string" ? notes : null },
    );
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof LedgerError) return NextResponse.json({ error: err.message }, { status: err.status });
    console.error("history archive import failed", err);
    return NextResponse.json(
      { error: "That file couldn't be read. Export it again as CSV and retry." },
      { status: 400 },
    );
  }
}

// DELETE /api/financials/ledger/history?file=<id> — remove an archived file
// and its rows. finances:full, Pro+.
//
// Housekeeping, not an accounting act: nothing is derived from these rows, so
// removing a file somebody uploaded by mistake changes no number anywhere.
export async function DELETE(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "finances", "full");
  if (denied) return denied;
  const tierGate = await requireTierFeature(session.user.clubId, "fullFinancials");
  if (tierGate) return tierGate;

  const fileId = new URL(req.url).searchParams.get("file");
  if (!fileId) return NextResponse.json({ error: "Which file?" }, { status: 400 });
  try {
    const removed = await deleteHistoryFile(session.user.clubId, fileId);
    return NextResponse.json({ ok: true, removed });
  } catch (err) {
    if (err instanceof LedgerError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
