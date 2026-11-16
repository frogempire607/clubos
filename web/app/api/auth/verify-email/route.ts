import { NextResponse } from "next/server";
import { confirmEmailWithToken } from "@/lib/emailLinkServer";
import { rateLimit, rateLimitedResponse, ipFromRequest } from "@/lib/ratelimit";

// POST /api/auth/verify-email { token }
// Uses an emailed confirmation link. No session: the signed token IS the
// proof, and the person may be opening the email on a different device.
//
// POST, not GET, on purpose: mail scanners and link previews fetch every URL
// in an email, and a GET that confirmed the address would let a scanner do it
// before the person ever looked. The page at /verify-email shows a button.
export async function POST(req: Request) {
  const rl = rateLimit({ key: `auth:verify-email:${ipFromRequest(req)}`, limit: 20, windowMs: 10 * 60_000 });
  if (!rl.allowed) return rateLimitedResponse(rl, "Too many attempts. Try again in a few minutes.");

  const body = (await req.json().catch(() => null)) as { token?: unknown } | null;
  const result = await confirmEmailWithToken(typeof body?.token === "string" ? body.token : null);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({
    ok: true,
    alreadyVerified: result.alreadyVerified,
    linkedOwnRecord: result.linkedOwnRecord,
    linkedChildren: result.linkedChildren,
  });
}
