// Phase 4.5.5 — staff-initiated password reset.
//
// 4.5.5 shipped the DIALOG in session 2 and nothing behind it, which is why the
// menu item silently did nothing. This is the behaviour.
//
// ── The rule that shapes this file ───────────────────────────────────────────
// The destination address is resolved SERVER-SIDE, always, from the member's own
// records. The client never supplies it. A staffer with members:edit who could
// post `{ email: "me@attacker.test" }` would be able to redirect any member's
// (or guardian's) reset link into their own inbox and take the account over —
// so there is deliberately no such field, and "Use a different email" in the
// dialog routes to the member editor rather than to this endpoint.
//
// Everything else reuses the shipped machinery: the same token column, the same
// 1-hour expiry, and the same /reset-password page as the public forgot-password
// flow, which is single-use by construction.

import { NextResponse } from "next/server";
import crypto from "crypto";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { sendPasswordResetEmail } from "@/lib/email";
import { baseUrlFromRequest } from "@/lib/baseUrl";
import { rateLimit, rateLimitedResponse } from "@/lib/ratelimit";

type Target = {
  user: { id: string; email: string; firstName: string | null } | null;
  email: string | null;
  isGuardianEmail: boolean;
  reason: "OK" | "NO_EMAIL" | "NO_LOGIN";
};

/**
 * Who actually receives this link.
 *
 * A minor generally has no login of their own — the guardian holds the account
 * (see the guardian/minor model in CLAUDE.md). So the search order is: the
 * member's own live login → a confirmed guardian's login → nothing. The dialog
 * renders `isGuardianEmail` so the staffer can see they're about to email a
 * parent, not the child.
 */
async function resolveTarget(clubId: string, memberId: string): Promise<Target> {
  const member = await prisma.member.findFirst({
    where: { id: memberId, clubId, deletedAt: null },
    select: {
      email: true,
      guardianEmail: true,
      user: { select: { id: true, email: true, firstName: true, deletedAt: true } },
      guardianLinks: {
        where: { status: "CONFIRMED" },
        orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
        select: { user: { select: { id: true, email: true, firstName: true, deletedAt: true } } },
      },
    },
  });
  if (!member) return { user: null, email: null, isGuardianEmail: false, reason: "NO_EMAIL" };

  // A soft-deleted login is not an account — NextAuth rejects it, so a reset
  // link sent there can never work. Treat it as absent (same rule as
  // /api/auth/forgot-password).
  if (member.user && !member.user.deletedAt) {
    return {
      user: { id: member.user.id, email: member.user.email, firstName: member.user.firstName },
      email: member.user.email,
      isGuardianEmail: false,
      reason: "OK",
    };
  }

  const guardian = member.guardianLinks.map((l) => l.user).find((u) => u && !u.deletedAt);
  if (guardian) {
    return {
      user: { id: guardian.id, email: guardian.email, firstName: guardian.firstName },
      email: guardian.email,
      isGuardianEmail: true,
      reason: "OK",
    };
  }

  // No login anywhere. Say which — "no account yet" and "no address on file"
  // need different fixes, and the dialog offers different buttons for each.
  const known = member.email ?? member.guardianEmail ?? null;
  return {
    user: null,
    email: known,
    isGuardianEmail: !member.email && !!member.guardianEmail,
    reason: known ? "NO_LOGIN" : "NO_EMAIL",
  };
}

// GET — what the dialog needs to render before the staffer commits.
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "members", "edit");
  if (denied) return denied;

  const t = await resolveTarget(session.user.clubId, params.id);
  return NextResponse.json({
    email: t.email,
    isGuardianEmail: t.isGuardianEmail,
    canSend: t.reason === "OK",
    reason: t.reason,
  });
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "members", "edit");
  if (denied) return denied;

  // The dialog enforces a 60s cooldown client-side; this is the server's own
  // bound so a scripted caller can't turn the button into an email cannon.
  const rl = rateLimit({ key: `members:password-reset:${session.user.id}`, limit: 20, windowMs: 60_000 });
  if (!rl.allowed) return rateLimitedResponse(rl, "Too many reset emails. Wait a moment and try again.");

  const t = await resolveTarget(session.user.clubId, params.id);
  if (t.reason !== "OK" || !t.user) {
    return NextResponse.json(
      {
        error:
          t.reason === "NO_LOGIN"
            ? "This member has no portal account yet — send an invitation instead."
            : "There is no email address on file for this member.",
        reason: t.reason,
      },
      { status: 409 },
    );
  }

  const resetToken = crypto.randomBytes(32).toString("hex");
  const resetExpires = new Date(Date.now() + 1000 * 60 * 60); // 60 min — matches the dialog's copy.
  await prisma.user.update({ where: { id: t.user.id }, data: { resetToken, resetExpires } });

  const club = await prisma.club.findUnique({
    where: { id: session.user.clubId },
    select: { name: true },
  });

  const resetUrl = `${baseUrlFromRequest(req)}/reset-password?token=${resetToken}`;
  try {
    await sendPasswordResetEmail({
      to: t.user.email,
      firstName: t.user.firstName ?? "there",
      clubName: club?.name ?? "your club",
      resetUrl,
    });
  } catch (err) {
    // The token is already stored, so the link is live either way — but the
    // staffer must not be told "sent" when the transport refused it.
    console.error("[members/password-reset] send failed", err);
    return NextResponse.json({ error: "Could not send the email. Check Settings → Email." }, { status: 502 });
  }

  // Attribution, said out loud — the dialog promises "Sent as <staff> and recorded".
  await prisma.memberMigrationEvent
    .create({
      data: {
        clubId: session.user.clubId,
        memberId: params.id,
        type: "NOTE",
        message: `Password reset emailed to ${t.user.email}${t.isGuardianEmail ? " (guardian)" : ""}`,
        actorUserId: session.user.id,
      },
    })
    .catch(() => {});

  return NextResponse.json({ ok: true, email: t.user.email, isGuardianEmail: t.isGuardianEmail, sentAt: new Date().toISOString() });
}
