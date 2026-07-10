import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { sendMembershipReactivationEmail, smtpMissingVars } from "@/lib/email";
import { writeBillingAudit } from "@/lib/billingAudit";
import { loadReactivationEmailContext } from "@/lib/reactivation";

// POST /api/members/[id]/reactivation/send  (billing:full)
// Send (or resend) the standard AthletixOS reactivation email for the
// member's open offer. What goes out is exactly what the preview endpoint
// rendered — same context loader. Sending never charges anything.
export async function POST(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "billing", "full");
  if (denied) return denied;

  const missing = smtpMissingVars();
  if (missing.length) {
    return NextResponse.json(
      { error: `Email isn't configured (missing ${missing.join(", ")}) — the message can't be sent.` },
      { status: 503 },
    );
  }

  const ctx = await loadReactivationEmailContext(id, session.user.clubId);
  if ("error" in ctx) return NextResponse.json({ error: ctx.error }, { status: 409 });

  try {
    await sendMembershipReactivationEmail(ctx.params);
  } catch (e) {
    console.error("Reactivation email send failed:", e);
    return NextResponse.json({ error: "The email could not be sent. Try again in a minute." }, { status: 502 });
  }

  const updated = await prisma.membershipReactivation.update({
    where: { id: ctx.reactivation.id },
    data: {
      status: "SENT",
      emailSentAt: new Date(),
      emailSendCount: { increment: 1 },
      sentToEmail: ctx.params.to,
    },
  });

  await writeBillingAudit({
    clubId: session.user.clubId,
    memberId: id,
    actorUserId: session.user.id,
    action: "REACTIVATION_SENT",
    after: { to: ctx.params.to, offerVersion: updated.offerVersion, sendCount: updated.emailSendCount },
    note: `Reactivation email ${updated.emailSendCount > 1 ? "re" : ""}sent to ${ctx.params.to}.`,
  });
  await prisma.memberMigrationEvent.create({
    data: {
      clubId: session.user.clubId,
      memberId: id,
      type: "NOTE",
      message: `Reactivation email sent to ${ctx.params.to}`,
      actorUserId: session.user.id,
    },
  }).catch(() => {});

  return NextResponse.json({ ok: true, sentTo: ctx.params.to, sendCount: updated.emailSendCount });
}
