import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getActionCenter } from "@/lib/actionCenter";

// GET /api/dashboard/action-center
// Permission-filtered, self-clearing list of items that need owner/staff
// attention. Owners see everything; staff see only what their permissions
// allow. See lib/actionCenter.ts for the per-kind gating.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const data = await getActionCenter(session);
  return NextResponse.json(data);
}
