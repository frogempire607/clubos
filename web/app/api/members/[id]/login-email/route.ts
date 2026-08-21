// PATCH /api/members/[id]/login-email
//
// Change the address a member SIGNS IN with.
//
// ── Why this needs its own route ────────────────────────────────────────────
//
// `members.email` (contact) and `users.email` (login) are different columns and
// are allowed to differ — a live case had a member's contact on one address
// while their login was another entirely.
//
// ── How this relates to D-0 ─────────────────────────────────────────────────
//
// PATCH /api/members/[id] carries D-0: editing the contact email ALSO moves the
// login, but ONLY when the member owns that login (`Member.userId`). That is
// the common case and it should stay one action — a staffer fixing a typo
// expects the person to be able to sign in with the corrected address.
//
// This route is the case D-0 deliberately refuses:
//
//   • the login is held by a GUARDIAN, so an edit to the child's contact must
//     not touch the adult's credential — D-0 leaves it alone, and without this
//     route there was no way to change it at all;
//   • the two addresses should legitimately stay different, and you want to
//     move only the login;
//   • the contact address is already correct and only the login is stale, so
//     there is no contact edit to piggyback on.
//
// Same guardrails as D-0, deliberately: reject a taken address (including one
// an archived login is still reserving), notify both sides, audit the change.
// Two paths, one policy.
//
// ── Guardrails ──────────────────────────────────────────────────────────────
//
// 1. REJECT if the address already belongs to another login in this club —
//    INCLUDING a soft-deleted one. `users (clubId, email)` is a plain global
//    unique index that ignores `deletedAt` (see CLAUDE.md "Critical
//    Invariants"), so a soft-deleted row silently reserves the slot and a
//    blind update would 500 on the constraint. The error names which case it
//    is, because "archived account is holding that address" and "another
//    member is using it" need different fixes.
// 2. NOTIFY BOTH addresses. The old one because losing sign-in access without
//    warning is indistinguishable from being locked out; the new one because
//    it is now a credential and its owner should know.
// 3. AUDIT. A MemberMigrationEvent with the actor, both addresses, and the
//    time — the same log the profile's Migration activity tab renders.
//
// Deliberately NOT done here: the password is not reset, no session is
// invalidated, and no membership, billing or migration state moves. This
// changes one column and tells two people about it.
//
// Gated on members:full, not members:edit. Editing a phone number and moving
// somebody's credential are different-sized actions, and a front-desk role
// that can do the first should not be able to do the second.

import { NextResponse } from "next/server";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { sendEmail } from "@/lib/email";

const schema = z.object({
  email: z.string().trim().email("That does not look like an email address.").max(200),
});

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "members", "full");
  if (denied) return denied;

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json().catch(() => ({})));
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
    throw err;
  }

  const nextEmail = body.email.toLowerCase();
  const clubId = session.user.clubId;

  const member = await prisma.member.findFirst({
    where: { id, clubId, deletedAt: null },
    select: {
      id: true, firstName: true, lastName: true,
      user: { select: { id: true, email: true } },
      club: { select: { name: true, emailFromName: true, emailReplyTo: true, contactEmail: true } },
    },
  });
  if (!member) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (!member.user) {
    return NextResponse.json(
      {
        error:
          "This member has no portal login yet, so there is no sign-in address to change. Send an invitation instead.",
        code: "NO_LOGIN",
      },
      { status: 409 },
    );
  }

  const previousEmail = member.user.email;
  if (previousEmail.toLowerCase() === nextEmail) {
    return NextResponse.json({ ok: true, unchanged: true, email: previousEmail });
  }

  // Guardrail 1 — the slot must be genuinely free. `findFirst` without a
  // deletedAt filter is deliberate: the unique index does not filter either.
  const holder = await prisma.user.findFirst({
    where: { clubId, email: nextEmail },
    select: { id: true, deletedAt: true, firstName: true, lastName: true, role: true },
  });
  if (holder && holder.id !== member.user.id) {
    const who = `${holder.firstName ?? ""} ${holder.lastName ?? ""}`.trim();
    return NextResponse.json(
      holder.deletedAt
        ? {
            error:
              `An archived account is still holding ${nextEmail}${who ? ` (${who})` : ""}. ` +
              "Archived logins keep their address reserved, so it has to be released before it can be reused.",
            code: "EMAIL_TAKEN_ARCHIVED",
          }
        : {
            error:
              `${nextEmail} is already the sign-in address for ${who || "another account"} at this club. ` +
              "Two people cannot share a login.",
            code: "EMAIL_TAKEN",
          },
      { status: 409 },
    );
  }

  const updated = await prisma.user.update({
    where: { id: member.user.id },
    data: { email: nextEmail },
    select: { id: true, email: true },
  });

  const memberName = `${member.firstName} ${member.lastName}`.trim();
  const staffName = [session.user.name, session.user.email].find(Boolean) ?? "a staff member";

  // Guardrail 3 — audit before notifying, so a failed send never loses the
  // record of what actually changed.
  await prisma.memberMigrationEvent.create({
    data: {
      clubId,
      memberId: member.id,
      type: "NOTE",
      message: `Sign-in email changed from ${previousEmail} to ${nextEmail} by ${staffName}`,
      actorUserId: (session.user.id as string) ?? null,
    },
  });

  // Guardrail 2 — tell both addresses. Failures are logged, never thrown: the
  // change has already happened, and reporting an error the caller would read
  // as "it did not work" would be worse than a missing notification.
  const clubName = member.club?.name ?? "your club";
  const fromName = member.club?.emailFromName || clubName;
  const replyTo = member.club?.emailReplyTo || member.club?.contactEmail || null;
  const notify = async (to: string, html: string, subject: string) => {
    try {
      await sendEmail({ to, subject, html, fromName, replyTo });
    } catch (e) {
      console.error("[login-email] notification failed", to, e);
    }
  };

  await notify(
    previousEmail,
    `<p>Hello,</p>
     <p>The sign-in email for <strong>${escapeHtml(memberName)}</strong>'s ${escapeHtml(clubName)} account was changed
     from <strong>${escapeHtml(previousEmail)}</strong> to <strong>${escapeHtml(nextEmail)}</strong> by
     ${escapeHtml(staffName)}.</p>
     <p>This address can no longer be used to sign in. Nothing else about the membership, bookings or payments changed,
     and no password was reset.</p>
     <p><strong>If you did not expect this, contact ${escapeHtml(clubName)} straight away.</strong></p>`,
    `Sign-in email changed for ${memberName}`,
  );
  await notify(
    nextEmail,
    `<p>Hello,</p>
     <p><strong>${escapeHtml(nextEmail)}</strong> is now the sign-in email for
     <strong>${escapeHtml(memberName)}</strong>'s ${escapeHtml(clubName)} account. It was changed by
     ${escapeHtml(staffName)}.</p>
     <p>Your password has not changed. If you do not know it, use "Forgot password" on the sign-in page.</p>
     <p><strong>If you did not expect this, contact ${escapeHtml(clubName)} straight away.</strong></p>`,
    `You now sign in to ${clubName} with this address`,
  );

  return NextResponse.json({ ok: true, email: updated.email, previousEmail });
}

/** Names and club names go into HTML; escape them rather than trusting input. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
