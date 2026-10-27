import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { formatZodError } from "@/lib/zodErrors";
import { requireOwnerLive } from "@/lib/apiGuard";
import { ipFromRequest, rateLimit, rateLimitedResponse } from "@/lib/ratelimit";
import { TinError, revealTin } from "@/lib/contractorTin";

export const dynamic = "force-dynamic";

// POST /api/contractors/[id]/w9/reveal — the full tax id, once, for an owner.
//
// ⚠️  THE ONLY ROUTE IN ATHLETIXOS THAT RETURNS A TAX IDENTIFICATION NUMBER.
//
//  · OWNER ONLY. Not staff-manager, not payroll, not finances:full. A
//    colleague's tax number is not staff administration.
//  · A POST, not a GET, so it can never be reached by a link, a prefetch, a
//    crawler or a browser's history — and so no tax id can end up in a URL,
//    a referer header or an access log.
//  · AUDITED BEFORE IT HAPPENS, in lib/contractorTin.revealTin. If the audit
//    row cannot be written the tax id is not returned: an unaudited read is
//    refused rather than allowed.
//  · Rate-limited, because the legitimate use is copying one number onto one
//    form a few times a year.
//  · Cache-Control: no-store, so the response is never written to disk by a
//    proxy or the browser.
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  // Explicit, before the guard: requireOwnerLive loses TypeScript's
  // null-narrowing on `session` (CLAUDE.md gotcha #1).
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const notOwner = await requireOwnerLive(session);
  if (notOwner) return notOwner;

  const rl = rateLimit({
    key: `w9:reveal:${session.user.id ?? ipFromRequest(req)}`,
    limit: 20,
    windowMs: 10 * 60 * 1000,
  });
  if (!rl.allowed) return rateLimitedResponse(rl);

  const parsed = z
    .object({ reason: z.string().trim().max(200).optional() })
    .strict()
    .safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json(formatZodError(parsed.error), { status: 400 });

  try {
    const revealed = await revealTin(
      session.user.clubId,
      params.id,
      { userId: session.user.id ?? null, name: session.user.name ?? null },
      parsed.data.reason ?? null,
    );
    return NextResponse.json(
      { tin: revealed.tin, kind: revealed.kind, legalName: revealed.legalName },
      { headers: { "Cache-Control": "no-store, no-cache, must-revalidate", Pragma: "no-cache" } },
    );
  } catch (err) {
    if (err instanceof TinError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
