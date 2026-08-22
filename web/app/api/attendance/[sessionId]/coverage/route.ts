import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { coverageForMembers, loadSessionCoverageContext } from "@/lib/coverageQuery";

// GET /api/attendance/[sessionId]/coverage?memberIds=a,b,c
//
// READ-ONLY. Verdicts for members who are NOT on the roster yet, so the
// Quick-Add search can show the shortfall at the moment staff go to add
// somebody — not after the record exists. Nothing here writes.
export const dynamic = "force-dynamic";

const MAX = 100;

export async function GET(req: Request, context: { params: Promise<{ sessionId: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const ids = (new URL(req.url).searchParams.get("memberIds") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX);
  if (ids.length === 0) return NextResponse.json({ coverage: {} });

  const ctx = await loadSessionCoverageContext(params.sessionId, session.user.clubId);
  if (!ctx) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const coverage = await coverageForMembers(ids, ctx, session.user.clubId);
  return NextResponse.json({ coverage: Object.fromEntries(coverage) });
}
