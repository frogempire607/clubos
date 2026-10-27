import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { formatZodError } from "@/lib/zodErrors";
import { ipFromRequest, rateLimit, rateLimitedResponse } from "@/lib/ratelimit";
import { StaffDocError, myStaffDocuments, signStaffDocument } from "@/lib/staffDocumentsServer";

export const dynamic = "force-dynamic";

// GET /api/me/documents — MY staff documents and where I stand on each.
//
// Takes no id, so there is nothing to tamper with and no way to ask about a
// colleague: "staff can't see other staff's documents or signatures" is
// structural here, not a check. The query loads only this user's own
// signatures — a colleague's is never fetched, let alone filtered out.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const userId = session.user.id;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const result = await myStaffDocuments(session.user.clubId, userId);
  return NextResponse.json({ ...result, signerName: `${session.user.name ?? ""}`.trim() || null });
}

const signSchema = z
  .object({
    documentId: z.string().min(1),
    signerName: z.string().trim().min(1).max(200),
    /// Optional drawn signature, same PNG data URL the member flow uses.
    signatureDataUrl: z.string().max(300_000).nullable().optional(),
    /// The reader must confirm. A signature nobody ticked is not consent.
    agreed: z.literal(true),
  })
  .strict();

// POST /api/me/documents — sign one of MY documents.
//
// Signing a document this person is not assigned returns 404, not 403:
// whether a document exists is not something an unassigned staff member needs
// to learn from a guessed id.
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const userId = session.user.id;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rl = rateLimit({ key: `staffdoc:sign:${userId}`, limit: 30, windowMs: 10 * 60 * 1000 });
  if (!rl.allowed) return rateLimitedResponse(rl);

  const parsed = signSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json(formatZodError(parsed.error), { status: 400 });
  const { agreed, ...draft } = parsed.data;
  void agreed;

  try {
    const result = await signStaffDocument(
      session.user.clubId,
      draft.documentId,
      userId,
      { signerName: draft.signerName, signatureDataUrl: draft.signatureDataUrl ?? null },
      { ipAddress: ipFromRequest(req), userAgent: req.headers.get("user-agent") },
    );
    const refreshed = await myStaffDocuments(session.user.clubId, userId);
    return NextResponse.json({ ok: true, ...result, ...refreshed });
  } catch (err) {
    if (err instanceof StaffDocError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
