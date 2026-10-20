import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { putObject } from "@/lib/storage";
import { requirePermissionLive } from "@/lib/apiGuard";
import { requireTierFeature } from "@/lib/tierGuard";
import { ledgerActor } from "@/lib/ledgerGuard";
import { rateLimit, rateLimitedResponse } from "@/lib/ratelimit";
import { LedgerError, addAttachment } from "@/lib/ledgerServer";

export const dynamic = "force-dynamic";

// Same set the receipt inbox accepts, plus CSV — a journal entry's backup is
// often a statement extract, not a photo.
const ALLOWED = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
  "image/webp",
  "text/csv",
]);
const MAX_BYTES = 10 * 1024 * 1024;
const PER_REQUEST = 10;

// POST /api/financials/ledger/entries/[id]/attachments  (multipart: file, …)
// Attach supporting documents to a journal entry. finances:edit, Pro+.
//
// REUSES THE EXISTING RECEIPT/FILE STORAGE, exactly as lib/receiptsServer.ts
// addReceipt does: bytes go through lib/storage.ts putObject (Supabase Storage
// in production, local disk in dev), an UploadedFile row records them with a
// random storage key, and reads go back through the existing authenticated,
// club-scoped gate at /api/files/[id]. There is no new storage path, no new
// bucket, and no public URL for an accounting document.
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
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

  const rl = rateLimit({ key: `gl:attach:${actor.userId ?? clubId}`, limit: 20, windowMs: 60_000 });
  if (!rl.allowed) return rateLimitedResponse(rl, "Too many uploads at once. Wait a moment and try again.");

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }
  const files = form.getAll("file").filter((f): f is File => f instanceof File);
  if (files.length === 0) return NextResponse.json({ error: "Choose at least one file." }, { status: 400 });
  if (files.length > PER_REQUEST) {
    return NextResponse.json({ error: `Up to ${PER_REQUEST} files at a time.` }, { status: 400 });
  }

  // Confirm the entry is this club's BEFORE storing any bytes, so a bad entry
  // id can't be used to write files against the club's storage quota.
  const entry = await prisma.glJournalEntry.findFirst({ where: { id, clubId: clubId }, select: { id: true } });
  if (!entry) return NextResponse.json({ error: "That entry doesn't exist in this club." }, { status: 404 });

  const rejected: { name: string; reason: string }[] = [];
  let latest = null;

  for (const f of files) {
    const type = f.type || (/\.heic$/i.test(f.name) ? "image/heic" : /\.csv$/i.test(f.name) ? "text/csv" : "");
    if (!ALLOWED.has(type)) {
      rejected.push({ name: f.name, reason: "Only PDFs, photos (JPG, PNG, HEIC, WebP) and CSV files." });
      continue;
    }
    if (f.size <= 0 || f.size > MAX_BYTES) {
      rejected.push({ name: f.name, reason: "Must be under 10 MB." });
      continue;
    }
    const buf = Buffer.from(await f.arrayBuffer());
    const ext = f.name.split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") || "bin";
    const storageKey = `${randomBytes(16).toString("hex")}.${ext}`;
    await putObject(storageKey, buf, type);
    const stored = await prisma.uploadedFile.create({
      data: {
        clubId: clubId,
        uploaderId: actor.userId,
        storageKey,
        originalName: f.name.slice(0, 200),
        mimeType: type,
        sizeBytes: buf.length,
        kind: "LEDGER",
      },
    });
    try {
      latest = await addAttachment(
        clubId,
        id,
        { fileId: stored.id, fileName: f.name, mimeType: type, sizeBytes: buf.length },
        actor,
      );
    } catch (err) {
      if (err instanceof LedgerError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      throw err;
    }
  }

  if (!latest) {
    return NextResponse.json({ error: rejected[0]?.reason ?? "Nothing was attached.", rejected }, { status: 400 });
  }
  return NextResponse.json({ entry: latest, rejected });
}
