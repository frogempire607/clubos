import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requirePermissionLive } from "@/lib/apiGuard";
import { rateLimit, rateLimitedResponse } from "@/lib/ratelimit";
import { addReceipt, listReceipts, RECEIPT_MAX_BYTES, RECEIPT_TYPES } from "@/lib/receiptsServer";
import { requireTierFeature } from "@/lib/tierGuard";

export const dynamic = "force-dynamic";
const PER_REQUEST = 25;

// GET /api/financials/receipts?status=UNMATCHED|MATCHED|IGNORED|ALL — the
// inbox with suggested bank rows for each unmatched receipt. finances:view.
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "finances", "view");
  if (denied) return denied;
  // Tier gate (pricing overhaul 2026-10-18) — enforced server-side.
  const tierGate = await requireTierFeature(session.user.clubId, "fullFinancials");
  if (tierGate) return tierGate;
  const status = new URL(req.url).searchParams.get("status") ?? "UNMATCHED";
  if (!["UNMATCHED", "MATCHED", "IGNORED", "ALL"].includes(status)) return NextResponse.json({ error: "Bad status" }, { status: 400 });
  return NextResponse.json({ receipts: await listReceipts(session.user.clubId, status) });
}

// POST /api/financials/receipts (multipart: file, file, …) — drop receipts in.
// Up to 25 per request (the page sends batches). finances:full.
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "finances", "full");
  if (denied) return denied;
  // Tier gate (pricing overhaul 2026-10-18) — enforced server-side.
  const tierGate = await requireTierFeature(session.user.clubId, "fullFinancials");
  if (tierGate) return tierGate;
  const rl = rateLimit({ key: `receipts:${session.user.id}`, limit: 20, windowMs: 60_000 });
  if (!rl.allowed) return rateLimitedResponse(rl, "Too many uploads at once. Wait a moment and try again.");
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }
  const files = form.getAll("file").filter((f): f is File => f instanceof File);
  if (files.length === 0) return NextResponse.json({ error: "Choose at least one file." }, { status: 400 });
  if (files.length > PER_REQUEST) return NextResponse.json({ error: `Up to ${PER_REQUEST} files at a time.` }, { status: 400 });
  const added: string[] = [];
  const rejected: { name: string; reason: string }[] = [];
  for (const f of files) {
    const type = f.type || (/\.heic$/i.test(f.name) ? "image/heic" : "");
    if (!RECEIPT_TYPES.has(type)) { rejected.push({ name: f.name, reason: "Only PDFs and photos (JPG, PNG, HEIC, WebP)." }); continue; }
    if (f.size <= 0 || f.size > RECEIPT_MAX_BYTES) { rejected.push({ name: f.name, reason: "Must be under 10 MB." }); continue; }
    const rc = await addReceipt({ clubId: session.user.clubId, userId: session.user.id ?? null, fileName: f.name, mimeType: type, buf: Buffer.from(await f.arrayBuffer()) });
    added.push(rc.id);
  }
  return NextResponse.json({ ok: true, added: added.length, rejected }, { status: added.length ? 201 : 400 });
}
