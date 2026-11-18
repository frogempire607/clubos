import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ipFromRequest, rateLimit } from "@/lib/ratelimit";
import { MAX_BODY_BYTES, fingerprintOf, isNoise, parseReport } from "@/lib/clientErrors";

// POST /api/public/client-errors — a screen crashed in someone's browser.
//
// Open to anyone on purpose: the login, signup, activation and public event
// pages can crash too, and a crash can happen to someone whose session just
// expired. So nothing in the body is trusted:
//   · the body is size-capped, parsed and scrubbed again (lib/clientErrors.ts);
//   · WHO it happened to comes from the session cookie, never from the body;
//   · 30 reports a minute per address, then they are dropped;
//   · the IP address is used for that limit and is not stored.
//
// It always answers 204. A reporter that is told "that failed" has nothing
// useful to do about it, and the table not existing yet (the migration is
// applied separately) must not turn every crash into a second error.
export const dynamic = "force-dynamic";

const done = () => new NextResponse(null, { status: 204 });

export async function POST(req: Request) {
  try {
    const limited = rateLimit({ key: `client-error:${ipFromRequest(req)}`, limit: 30, windowMs: 60_000 });
    if (!limited.allowed) return done();

    const raw = await req.text();
    if (!raw || raw.length > MAX_BODY_BYTES) return done();
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return done(); }
    const report = parseReport(body);
    if (!report || isNoise(report)) return done();

    const session = await getServerSession(authOptions).catch(() => null);
    const user = session?.user as { id?: string; clubId?: string; role?: string } | undefined;

    // The function log gets a line either way, so a crash is findable even
    // before the table exists.
    console.error(`[client-error] ${report.source} ${report.path} — ${report.message}`);

    try {
      await prisma.clientError.create({
        data: {
          source: report.source,
          path: report.path,
          message: report.message,
          stack: report.stack,
          digest: report.digest,
          fingerprint: fingerprintOf(report),
          viewport: report.viewport,
          clubId: user?.clubId ?? null,
          userId: user?.id ?? null,
          role: user?.role ?? null,
          userAgent: (req.headers.get("user-agent") ?? "").slice(0, 300) || null,
          release: process.env.COMMIT_REF?.slice(0, 40) ?? null,
        },
      });
    } catch (e) {
      console.error("[client-error] could not store the report:", e instanceof Error ? e.message.split("\n")[0] : e);
    }
  } catch {
    /* never an error back to a page that is already in trouble */
  }
  return done();
}
