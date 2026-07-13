import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requirePermission } from "@/lib/apiGuard";
import { renderMembershipReactivationEmail } from "@/lib/email";
import { loadReactivationEmailContext } from "@/lib/reactivation";
import { baseUrlFromRequest } from "@/lib/baseUrl";

// GET /api/members/[id]/reactivation/preview  (billing:view)
// The exact email that /send would deliver (same context loader), rendered
// for the owner preview modal — subject, HTML, recipient, and the page URL.
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "billing", "view");
  if (denied) return denied;

  const ctx = await loadReactivationEmailContext(id, session.user.clubId, baseUrlFromRequest(req));
  if ("error" in ctx) return NextResponse.json({ error: ctx.error }, { status: 409 });

  const { subject, html } = renderMembershipReactivationEmail(ctx.params);
  return NextResponse.json({
    subject,
    html,
    to: ctx.params.to,
    pageUrl: ctx.params.reactivationUrl,
    offerVersion: ctx.reactivation.offerVersion,
  });
}
