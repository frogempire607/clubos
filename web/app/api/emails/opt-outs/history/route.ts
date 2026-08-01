// GET /api/emails/opt-outs/history?email=…
// Returns the audit timeline for one address. Used by the admin surface
// AND the profile Communications tab (3G).

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requirePermission, requireMessagesSubScope } from "@/lib/apiGuard";
import { readOptOutHistory } from "@/lib/optOutAudit";

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "messages", "view");
  if (denied) return denied;
  const scopeDenied = requireMessagesSubScope(session, "unsubscribe");
  if (scopeDenied) return scopeDenied;

  const email = (new URL(req.url).searchParams.get("email") || "").trim().toLowerCase();
  if (!email) return NextResponse.json({ error: "Missing email" }, { status: 400 });

  const rows = await readOptOutHistory(session.user.clubId, email, 200);
  return NextResponse.json({ history: rows });
}
