import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { upsertGuardianProfile } from "@/lib/guardian";
import { ensurePrimaryGuardian } from "@/lib/guardianLink";
import { deleteOrphanedMemberLogins } from "@/lib/memberLink";
import { validateMemberContact } from "@/lib/memberValidation";
import { resolveIsMinor } from "@/lib/parentalConsent";
import { loadFamilyForMember } from "@/lib/familyAccess";
import { MEMBER_TRACK_SELECT, serializeMemberForList, type SerializedMember } from "@/lib/memberDisplay";
import { buildTrackContext, loadSourceLabels } from "@/lib/membersQuery";
import { sendLoginEmailChangedEmail } from "@/lib/email";
import { baseUrlFromRequest } from "@/lib/baseUrl";

const updateSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  // Accept null/"" so a minor (or anyone) without their own email can be saved.
  // A bare z.string().email().optional() rejected null → "Expected string,
  // received null" when editing a minor with no email on file.
  email: z.string().email().optional().nullable().or(z.literal("")),
  phone: z.string().optional().nullable(),
  dateOfBirth: z.string().optional().nullable(),
  status: z.enum(["ACTIVE", "PROSPECT", "INACTIVE", "PAUSED"]).optional(),
  tags: z.string().optional(),
  notes: z.string().optional().nullable(),
  customFieldValues: z.record(z.string()).optional(),
  streetAddress: z.string().optional().nullable(),
  city:          z.string().optional().nullable(),
  state:         z.string().optional().nullable(),
  zipCode:       z.string().optional().nullable(),
  gender: z.string().optional().nullable(),
  isMinor: z.boolean().optional(),
  guardianName: z.string().optional().nullable(),
  guardianEmail: z.string().email().optional().nullable().or(z.literal("")),
  guardianPhone: z.string().optional().nullable(),
  guardianRelationship: z.string().optional().nullable(),
  profileImageUrl: z.string().optional().nullable(),
  // P4 correction — birthdayLocked + parentControls are NOT editable
  // from this owner endpoint. Guardian-only via
  // /api/member/family/[memberId]/controls. Stripped from the schema
  // so an owner client sending them just gets a Zod "unrecognized"
  // 400 instead of a silent override.
});

async function requireMember(memberId: string, clubId: string) {
  return prisma.member.findFirst({
    where: { id: memberId, clubId, deletedAt: null },
  });
}

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const member = await prisma.member.findFirst({
    where: { id: params.id, clubId: session.user.clubId, deletedAt: null },
    include: {
      // Whether the club passes the Stripe processing fee to customers — the
      // profile page needs it to show the true total charged next to a
      // recurring price (display only; fee math lives in lib/fees.ts).
      club: { select: { passProcessingFees: true } },
      membership: true,
      subscriptions: {
        include: { membership: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
      },
      transactions: { orderBy: { createdAt: "desc" }, take: 25 },
      bookings: {
        orderBy: { createdAt: "desc" },
        take: 50,
        include: {
          event: { select: { id: true, name: true, type: true, startsAt: true, endsAt: true } },
        },
      },
      attendanceRecords: {
        orderBy: { createdAt: "desc" },
        take: 50,
        include: {
          classSession: {
            select: {
              startsAt: true,
              recurringClass: { select: { name: true } },
            },
          },
        },
      },
      eventRegistrations: {
        orderBy: { createdAt: "desc" },
        take: 25,
        include: { event: { select: { id: true, name: true, startsAt: true } } },
      },
      relationshipsFrom: {
        include: { related: { select: { id: true, firstName: true, lastName: true, status: true } } },
      },
      relationshipsTo: {
        include: { member: { select: { id: true, firstName: true, lastName: true, status: true } } },
      },
      guardian: {
        include: {
          members: {
            where: { deletedAt: null, NOT: { id: params.id } },
            select: { id: true, firstName: true, lastName: true, isMinor: true, status: true },
          },
        },
      },
      // Phase 4.5.3 — the Account & security card states whether a portal
      // login exists, which address it signs in with, and when it was last
      // used. Scalars only: never the password hash, never the reset token.
      user: { select: { id: true, email: true, lastLoginAt: true } },
    },
  });
  if (!member) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Flatten relationships into one directionless list for the UI. Types are
  // stored from the `member` side; invert the asymmetric ones when this member
  // is on the `related` side so the label reads correctly.
  //
  // NOTE: these are DESCRIPTIVE LABELS ONLY. A MemberRelationship grants no
  // access whatsoever — the access edges are in `family` below. Keeping them
  // in one payload but under clearly separate keys is deliberate: presenting
  // MemberRelationship as if it were a family link is exactly what made the
  // Lister case unfixable from the dashboard.
  // `type` describes the ROW OWNER's role relative to the related member:
  // (memberId=Cameron, relatedMemberId=Michael, type=CHILD) means
  // "Cameron is the CHILD of Michael".
  //
  // So the inversion belongs on the FROM side, not the TO side — it was
  // backwards, and rendered "Michael Lister — Child" on Cameron's profile and
  // "Cameron Lister — Parent" on Michael's. Both read as the opposite of the
  // truth. Fixed on READ only: the stored rows are internally consistent and
  // need no migration (2 rows exist club-wide, both CHILD).
  //
  //   viewing Michael (he is `related`)  → other = Cameron, label = CHILD
  //   viewing Cameron (he is `member`)   → other = Michael, label = PARENT
  const invert: Record<string, string> = { PARENT: "CHILD", CHILD: "PARENT" };
  const relationships = [
    ...member.relationshipsFrom.map((r) => ({ id: r.id, type: invert[r.type] ?? r.type, note: r.note, other: r.related })),
    ...member.relationshipsTo.map((r) => ({ id: r.id, type: r.type, note: r.note, other: r.member })),
  ];

  // Phase 4B — the read gap. Guardians of this member, athletes this member's
  // login manages, and guardian requests awaiting staff. None of this was
  // returned before, so a correctly-linked child was invisible on the profile.
  const family = await loadFamilyForMember(params.id, session.user.clubId);

  // ── Phase 4.5.3 — the family switcher's people ──────────────────────────
  // `family` answers "who can act for this member" and "who can this member's
  // login act for". Neither answers "who else is in this family" — a sibling is
  // reachable only through a SHARED GUARDIAN, and a minor has no login of their
  // own, so both lists come back empty for exactly the case the switcher exists
  // for. Cameron Lister's profile showed no family at all despite Rory being
  // correctly linked to the same parent.
  //
  // So: take this member's guardians, and return every other athlete those
  // guardians manage. Confirmed links only — a PENDING link grants nothing and
  // must not put someone in a family they may not belong to.
  let familyMembers: {
    id: string;
    name: string;
    profileImageUrl: string | null;
    isMinor: boolean;
    viaGuardian: string;
    canPay: boolean;
  }[] = [];
  try {
    const guardianUserIds = family.guardians
      .filter((g) => g.status === "CONFIRMED")
      .map((g) => g.userId);
    if (guardianUserIds.length) {
      const siblings = await prisma.memberGuardianUser.findMany({
        where: {
          userId: { in: guardianUserIds },
          status: "CONFIRMED",
          memberId: { not: params.id },
          member: { clubId: session.user.clubId, deletedAt: null },
        },
        orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
        select: {
          canPay: true,
          user: { select: { firstName: true, lastName: true } },
          member: {
            select: { id: true, firstName: true, lastName: true, profileImageUrl: true, isMinor: true },
          },
        },
      });
      const seen = new Set<string>();
      for (const s of siblings) {
        if (seen.has(s.member.id)) continue;
        seen.add(s.member.id);
        familyMembers.push({
          id: s.member.id,
          name: `${s.member.firstName} ${s.member.lastName}`,
          profileImageUrl: s.member.profileImageUrl,
          isMinor: s.member.isMinor,
          viaGuardian: `${s.user.firstName ?? ""} ${s.user.lastName ?? ""}`.trim(),
          canPay: s.canPay,
        });
      }
    }
  } catch (e) {
    // The switcher is a convenience; the profile must still render without it.
    console.error("[members/[id]] family switcher resolution failed", e);
    familyMembers = [];
  }

  const { relationshipsFrom: _f, relationshipsTo: _t, club: _c, ...rest } = member;
  void _f; void _t;
  // Phase 4.5.3 — the profile reads the SAME derived tracks and the SAME
  // nextAction as the roster row and the mobile card. Additive: every existing
  // consumer of this endpoint keeps its keys, and `tracks`/`nextAction` simply
  // appear alongside them.
  //
  // Derived here rather than client-side for the reason 4.5.1 exists: two
  // staff must never see a different answer, and the profile banner and the
  // list button must never disagree about what to do next.
  let tracks: SerializedMember | null = null;
  try {
    const trackRow = await prisma.member.findFirst({
      where: { id: params.id, clubId: session.user.clubId },
      select: MEMBER_TRACK_SELECT,
    });
    if (trackRow) {
      const ctx = await buildTrackContext([trackRow.id]);
      ctx.sourceLabelByBatch = await loadSourceLabels([trackRow.importBatchId]);
      tracks = serializeMemberForList(trackRow, ctx);
    }
  } catch (e) {
    // A derivation failure must not take the whole profile down — every other
    // tab on this page works without it.
    console.error("[members/[id]] track derivation failed", e);
  }

  return NextResponse.json({
    ...rest,
    relationships,
    family,
    familyMembers,
    passProcessingFees: _c.passProcessingFees,
    tracks: tracks?.tracks ?? null,
    nextAction: tracks?.nextAction ?? null,
    sourceLabel: tracks?.sourceLabel ?? null,
  });
}

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const member = await requireMember(params.id, session.user.clubId);
  if (!member) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const body = await req.json();
    const data = updateSchema.parse(body);

    // P4 — owner cannot edit DOB on a parent-locked member.
    // The lock is set by the guardian from /member/family/[memberId];
    // owners only see the status on the edit modal. If the owner ever
    // genuinely needs to override (legal name correction, etc.) the
    // guardian has to unlock first OR a separate explicit admin
    // override flow with audit trail handles it — not this surface.
    if (data.dateOfBirth !== undefined && member.birthdayLockedAt) {
      const incoming = data.dateOfBirth ? new Date(data.dateOfBirth).getTime() : null;
      const current = member.dateOfBirth ? member.dateOfBirth.getTime() : null;
      if (incoming !== current) {
        return NextResponse.json(
          {
            error:
              "Parent-confirmed DOB is locked for athlete safety and eligibility integrity. The guardian must unlock from their family controls first.",
            code: "BIRTHDAY_LOCKED",
          },
          { status: 403 },
        );
      }
    }

    // (P4 — owners no longer set the lock from here; the schema
    // already excludes birthdayLocked/parentControls so any stray field
    // from an old client just gets stripped by Zod's default behavior.)

    // If marking as a minor, validate required guardian fields per spec.
    // If marking as an adult, require at least one direct contact method.
    // COPPA: date of birth is authoritative. If the effective DOB is under 18,
    // the member IS a minor no matter what isMinor was set to — an owner can't
    // clear the flag on a real child to dodge the parental-consent gate.
    const effectiveDob = data.dateOfBirth !== undefined ? data.dateOfBirth : member.dateOfBirth;
    const willBeMinor = resolveIsMinor({ isMinor: data.isMinor ?? member.isMinor, dateOfBirth: effectiveDob });
    const contactError = validateMemberContact({
      isMinor: willBeMinor,
      email: data.email ?? member.email,
      phone: data.phone ?? member.phone,
      guardianName: data.guardianName ?? member.guardianName,
      guardianEmail: data.guardianEmail ?? member.guardianEmail,
    });
    if (contactError) {
      return NextResponse.json({ error: contactError }, { status: 400 });
    }

    // ── D-0: an email edit moves the LOGIN too, but only when the member owns
    // that login (session 4) ─────────────────────────────────────────────────
    //
    // Julian: "When I change a member's email it should become their email
    // everywhere, including their login. But not blindly: if the account is
    // held by a guardian, editing the child's contact email must NOT move the
    // guardian's login."
    //
    // `Member.userId` is the member's OWN portal login and nothing else. A
    // guardian reaches a child through `MemberGuardianUser`, never through the
    // child's `userId` (CLAUDE.md — pointing a minor's userId at the guardian
    // inverts parental controls and hides siblings). So `member.userId` is
    // exactly the right test: set means "this address is their sign-in", null
    // means the account is held by somebody else and `members.email` is a
    // contact field only.
    //
    // Session 3 established the previous behaviour: a contact edit wrote
    // `members.email` alone and never touched `users.email`. That was correct
    // for the guardian-held case and wrong for the own-login case, where the
    // profile then advertised one address while sign-in and password resets
    // used another — the exact confusion that produced Julian's finding #1.
    const emailChanging =
      data.email !== undefined &&
      (data.email ? data.email.toLowerCase() : null) !== (member.email ? member.email.toLowerCase() : null);
    const nextEmail = data.email ? data.email.toLowerCase() : null;

    let loginMove: { userId: string; from: string; to: string } | null = null;
    if (emailChanging && member.userId && nextEmail) {
      const ownLogin = await prisma.user.findFirst({
        where: { id: member.userId },
        select: { id: true, email: true, deletedAt: true },
      });
      // A member row can point at a login that has since been archived. Nothing
      // to move in that case; the contact edit proceeds on its own.
      if (ownLogin && !ownLogin.deletedAt && ownLogin.email.toLowerCase() !== nextEmail) {
        // The (clubId, email) unique index is GLOBAL — it ignores deletedAt
        // (CLAUDE.md). So both a live and an archived account block the move,
        // and they need different explanations because they need different
        // fixes.
        const holder = await prisma.user.findFirst({
          where: { clubId: session.user.clubId, email: nextEmail, id: { not: ownLogin.id } },
          select: { id: true, firstName: true, lastName: true, role: true, deletedAt: true },
        });
        if (holder) {
          const who = `${holder.firstName ?? ""} ${holder.lastName ?? ""}`.trim() || nextEmail;
          // Refuse the WHOLE patch, not just the login half. Saving the contact
          // address while leaving the login on the old one is precisely the
          // split-brain this change exists to remove — better to change nothing
          // and say why.
          return NextResponse.json(
            holder.deletedAt
              ? {
                  error:
                    `${nextEmail} is still held by an archived account (${who}). Archived logins keep their address, ` +
                    `so it can't be reused yet. Nothing was saved — pick a different address, or ask an owner to free that one.`,
                  code: "EMAIL_HELD_BY_ARCHIVED",
                }
              : {
                  error:
                    `${nextEmail} is already the sign-in address for ${who}` +
                    `${holder.role && holder.role !== "MEMBER" ? ` (${holder.role.toLowerCase()})` : ""}. ` +
                    `Two people can't share one login, so nothing was saved.`,
                  code: "EMAIL_IN_USE",
                },
            { status: 409 },
          );
        }
        loginMove = { userId: ownLogin.id, from: ownLogin.email, to: nextEmail };
      }
    }

    // Upsert/relink guardian profile when guardian fields change
    let guardianIdUpdate: { guardianId?: string | null } = {};
    if (data.guardianName !== undefined || data.guardianEmail !== undefined || data.guardianPhone !== undefined || data.isMinor !== undefined) {
      const effectiveEmail = data.guardianEmail ?? member.guardianEmail;
      if (effectiveEmail) {
        const guardian = await upsertGuardianProfile(session.user.clubId, {
          guardianName: data.guardianName ?? member.guardianName,
          guardianEmail: effectiveEmail,
          guardianPhone: data.guardianPhone ?? member.guardianPhone,
        });
        guardianIdUpdate = { guardianId: guardian?.id ?? null };
      } else {
        guardianIdUpdate = { guardianId: null };
      }
    }

    // Only allow ACTIVE if the member has at least one active subscription.
    // Otherwise coerce to PROSPECT so status stays consistent with billing.
    let nextStatus = data.status;
    if (nextStatus === "ACTIVE") {
      const activeSub = await prisma.memberSubscription.count({
        where: { memberId: params.id, status: "active" },
      });
      if (activeSub === 0) nextStatus = "PROSPECT";
    }

    // Use UncheckedUpdateInput so we can write the FK column `guardianId`
    // directly via guardianIdUpdate (the relations-checked variant would
    // demand `guardian: { connect: ... }`).
    const updateData: Prisma.MemberUncheckedUpdateInput = {
      ...data,
      ...(nextStatus !== undefined ? { status: nextStatus } : {}),
      ...guardianIdUpdate,
      // Persist the DOB-authoritative minor status (see willBeMinor above).
      isMinor: willBeMinor,
      email: data.email !== undefined
        ? (data.email ? data.email.toLowerCase() : null)
        : undefined,
      guardianEmail: data.guardianEmail !== undefined
        ? (data.guardianEmail ? data.guardianEmail.toLowerCase() : null)
        : undefined,
      dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : data.dateOfBirth === null ? null : undefined,
      customFieldValues: data.customFieldValues ? JSON.stringify(data.customFieldValues) : undefined,
    };

    // One transaction: the contact address and the sign-in address must never
    // end up disagreeing because one of the two writes failed.
    const updated = loginMove
      ? await prisma.$transaction(async (tx) => {
          await tx.user.update({ where: { id: loginMove!.userId }, data: { email: loginMove!.to } });
          return tx.member.update({ where: { id: params.id }, data: updateData });
        })
      : await prisma.member.update({ where: { id: params.id }, data: updateData });

    if (loginMove) {
      // Attributed in migration activity like every other write on this route.
      try {
        await prisma.memberMigrationEvent.create({
          data: {
            clubId: session.user.clubId,
            memberId: params.id,
            type: "NOTE",
            message: `Sign-in email moved from ${loginMove.from} to ${loginMove.to}.`,
            actorUserId: session.user.id,
          },
        });
      } catch (e) {
        console.error("[members/[id]] login-move audit failed", e);
      }

      // Notify BOTH addresses. The old one is the only channel the person still
      // controls if this was a mistake, so telling only the new address would
      // make a takeover silent. Failures never break the save.
      try {
        const club = await prisma.club.findUnique({
          where: { id: session.user.clubId },
          select: { name: true },
        });
        const loginUrl = `${baseUrlFromRequest(req)}/login`;
        const changedBy = session.user.name || session.user.email || "A staff member";
        const common = {
          firstName: updated.firstName,
          clubName: club?.name ?? "your club",
          oldEmail: loginMove.from,
          newEmail: loginMove.to,
          changedBy,
          loginUrl,
        };
        await Promise.allSettled([
          sendLoginEmailChangedEmail({ ...common, to: loginMove.from, audience: "old" }),
          sendLoginEmailChangedEmail({ ...common, to: loginMove.to, audience: "new" }),
        ]);
      } catch (e) {
        console.error("[members/[id]] login-move notification failed", e);
      }
    }

    // Owner-vouched guardian link (same as the create path): when a minor has a
    // guardian email matching an existing portal account, link them so the child
    // shows in that guardian's portal immediately.
    if (updated.isMinor && updated.guardianEmail) {
      const guardianUser = await prisma.user.findFirst({
        where: { clubId: session.user.clubId, email: updated.guardianEmail, deletedAt: null },
        select: { id: true },
      });
      if (guardianUser) {
        await prisma.memberGuardianUser.upsert({
          where: { userId_memberId: { userId: guardianUser.id, memberId: updated.id } },
          update: {},
          create: {
            clubId: session.user.clubId,
            userId: guardianUser.id,
            memberId: updated.id,
            relationship: updated.guardianRelationship || null,
            status: "CONFIRMED",
            source: "OWNER_VOUCHED",
            createdByUserId: session.user.id,
            confirmedAt: new Date(),
          },
        });
        await ensurePrimaryGuardian(updated.id);
      }
    }

    return NextResponse.json(updated);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.flatten() }, { status: 400 });
    }
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}

export async function DELETE(_: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Staff with full Members access can delete — not owner-only.
  const denied = requirePermission(session, "members", "full");
  if (denied) return denied;

  const member = await requireMember(params.id, session.user.clubId);
  if (!member) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Release the unique members_userId slot on delete (the index is global and
  // ignores deletedAt) so the same person can be re-imported / re-activated
  // later without colliding with this dead row.
  await prisma.member.update({
    where: { id: params.id },
    data: { deletedAt: new Date(), userId: null },
  });

  // Also remove this member's own login so they can no longer sign in — unless
  // that account is shared (a guardian of another live member) or is owner/staff.
  await deleteOrphanedMemberLogins([member.userId], session.user.clubId);

  return NextResponse.json({ ok: true });
}
