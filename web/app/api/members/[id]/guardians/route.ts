// Staff-facing guardian access management for one member.
//
// ── Why this route exists ────────────────────────────────────────────────────
// Until Phase 4 the ONLY linking control the dashboard exposed was the
// Relationships card, which writes MemberRelationship — a descriptive label
// that grants nothing. When Cameron Lister didn't appear under his father's
// account, staff used that card (it was the only one there), the row landed in
// a table the portal never reads, and nothing changed. There was no way to
// grant, see, or revoke actual portal access from the dashboard at all.
//
// This route is the missing control: it writes MemberGuardianUser, the one
// table that is authorization.
//
//   GET    → who can act for this member, who this member's login manages,
//            pending requests, and candidate accounts to link
//   POST   → grant guardian access to an existing portal account
//   PATCH  → edit one link (permissions grid, relationship, primary)
//   DELETE → REVOKE access (status=REVOKED + revokedAt). Never a hard delete —
//            a family access change must stay auditable.

import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import {
  ACTIVE_GUARDIAN_LINK,
  GUARDIAN_LINK_SOURCE,
  GUARDIAN_LINK_STATUS,
  loadFamilyForMember,
} from "@/lib/familyAccess";
import { ensurePrimaryGuardian } from "@/lib/guardianLink";

async function requireMember(memberId: string, clubId: string) {
  return prisma.member.findFirst({
    where: { id: memberId, clubId, deletedAt: null },
    select: { id: true, clubId: true, firstName: true, lastName: true, email: true, guardianEmail: true },
  });
}

// Audit every access change on the member's own history so a future incident is
// reconstructable from the profile rather than from database forensics.
async function logAccessChange(args: {
  clubId: string;
  memberId: string;
  actorUserId: string;
  message: string;
}) {
  await prisma.memberMigrationEvent.create({
    data: {
      clubId: args.clubId,
      memberId: args.memberId,
      type: "NOTE",
      actorUserId: args.actorUserId,
      message: args.message,
    },
  });
}

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "members", "view");
  if (denied) return denied;

  const member = await requireMember(id, session.user.clubId);
  if (!member) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const family = await loadFamilyForMember(id, session.user.clubId);

  // Candidate accounts to link. A free-text search keeps this usable in a club
  // with hundreds of logins, but we also surface the two accounts most likely
  // to be the right answer, because guessing them is where staff got stuck:
  //   - the account matching the member's guardianEmail on file
  //   - the account matching the member's OWN email
  // The second is the Cameron shape: the parent's real address sitting in the
  // athlete's contact field.
  const q = (new URL(req.url).searchParams.get("q") || "").trim();
  const linkedUserIds = new Set(family.guardians.map((g) => g.userId));

  const candidates = await prisma.user.findMany({
    where: {
      clubId: session.user.clubId,
      deletedAt: null,
      id: { notIn: [...linkedUserIds] },
      ...(q
        ? {
            OR: [
              { email: { contains: q, mode: "insensitive" } },
              { firstName: { contains: q, mode: "insensitive" } },
              { lastName: { contains: q, mode: "insensitive" } },
            ],
          }
        : {
            OR: [
              ...(member.guardianEmail ? [{ email: member.guardianEmail.toLowerCase() }] : []),
              ...(member.email ? [{ email: member.email.toLowerCase() }] : []),
            ],
          }),
    },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    take: 25,
    select: {
      id: true, email: true, firstName: true, lastName: true, lastLoginAt: true,
      memberProfile: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  // If nothing is suggested and no search was typed, say why rather than
  // rendering a bare empty list.
  return NextResponse.json({
    ...family,
    candidates: candidates.map((u) => {
      const reasons: string[] = [];
      if (member.guardianEmail && u.email?.toLowerCase() === member.guardianEmail.toLowerCase()) {
        reasons.push("Matches the guardian email on file");
      }
      if (member.email && u.email?.toLowerCase() === member.email.toLowerCase()) {
        reasons.push("Matches this athlete's own email — likely the parent's address in the wrong field");
      }
      return {
        userId: u.id,
        name: `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() || (u.email ?? "Unknown"),
        email: u.email,
        neverSignedIn: !u.lastLoginAt,
        ownMemberId: u.memberProfile?.id ?? null,
        ownMemberName: u.memberProfile
          ? `${u.memberProfile.firstName} ${u.memberProfile.lastName}`.trim()
          : null,
        reasons,
      };
    }),
    searched: !!q,
  });
}

const createSchema = z.object({
  userId: z.string().min(1),
  relationship: z.string().max(60).optional().nullable(),
  canBook: z.boolean().optional(),
  canPay: z.boolean().optional(),
  canSignWaivers: z.boolean().optional(),
  canReceiveEmails: z.boolean().optional(),
  makePrimary: z.boolean().optional(),
});

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Granting someone access to a child's account is a real authorization
  // change, not a triage edit — it needs members:full, not members:edit.
  const denied = requirePermission(session, "members", "full");
  if (denied) return denied;

  const member = await requireMember(id, session.user.clubId);
  if (!member) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let data: z.infer<typeof createSchema>;
  try {
    data = createSchema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  const user = await prisma.user.findFirst({
    where: { id: data.userId, clubId: session.user.clubId, deletedAt: null },
    select: { id: true, email: true, firstName: true, lastName: true, memberProfile: { select: { id: true } } },
  });
  if (!user) return NextResponse.json({ error: "That account doesn't exist in this club." }, { status: 404 });

  // Linking a member to their own login is what Member.userId is for; a
  // self-referential guardian link would make the portal list them twice.
  if (user.memberProfile?.id === id) {
    return NextResponse.json(
      { error: "That's this athlete's own login. Guardian links are for other people's accounts." },
      { status: 400 },
    );
  }

  const existing = await prisma.memberGuardianUser.findUnique({
    where: { userId_memberId: { userId: user.id, memberId: id } },
    select: { id: true, status: true },
  });
  if (existing?.status === GUARDIAN_LINK_STATUS.CONFIRMED) {
    return NextResponse.json({ error: "That account already has access to this athlete." }, { status: 409 });
  }

  const link = await prisma.memberGuardianUser.upsert({
    where: { userId_memberId: { userId: user.id, memberId: id } },
    // Re-granting after a revoke is a deliberate staff action, so here (unlike
    // the self-service path in lib/guardianLink) restoring access is correct.
    update: {
      status: GUARDIAN_LINK_STATUS.CONFIRMED,
      revokedAt: null,
      confirmedAt: new Date(),
      relationship: data.relationship ?? null,
      source: GUARDIAN_LINK_SOURCE.STAFF_LINKED,
      createdByUserId: session.user.id,
      ...(data.canBook !== undefined ? { canBook: data.canBook } : {}),
      ...(data.canPay !== undefined ? { canPay: data.canPay } : {}),
      ...(data.canSignWaivers !== undefined ? { canSignWaivers: data.canSignWaivers } : {}),
      ...(data.canReceiveEmails !== undefined ? { canReceiveEmails: data.canReceiveEmails } : {}),
    },
    create: {
      clubId: session.user.clubId,
      userId: user.id,
      memberId: id,
      relationship: data.relationship ?? null,
      status: GUARDIAN_LINK_STATUS.CONFIRMED,
      source: GUARDIAN_LINK_SOURCE.STAFF_LINKED,
      createdByUserId: session.user.id,
      confirmedAt: new Date(),
      canBook: data.canBook ?? true,
      canPay: data.canPay ?? true,
      canSignWaivers: data.canSignWaivers ?? true,
      canReceiveEmails: data.canReceiveEmails ?? true,
    },
  });

  if (data.makePrimary) {
    await prisma.$transaction([
      prisma.memberGuardianUser.updateMany({ where: { memberId: id }, data: { isPrimary: false } }),
      prisma.memberGuardianUser.update({ where: { id: link.id }, data: { isPrimary: true } }),
    ]);
  }
  await ensurePrimaryGuardian(id);

  const who = `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || user.email || user.id;
  await logAccessChange({
    clubId: session.user.clubId,
    memberId: id,
    actorUserId: session.user.id,
    message:
      `Guardian access GRANTED to ${who} <${user.email}>${data.relationship ? ` (${data.relationship})` : ""}. ` +
      `Book:${data.canBook ?? true} Pay:${data.canPay ?? true} Waivers:${data.canSignWaivers ?? true} Emails:${data.canReceiveEmails ?? true}` +
      `${data.makePrimary ? " · set as primary guardian" : ""}.`,
  });

  return NextResponse.json({ ok: true, linkId: link.id }, { status: 201 });
}

const patchSchema = z.object({
  linkId: z.string().min(1),
  relationship: z.string().max(60).optional().nullable(),
  canBook: z.boolean().optional(),
  canPay: z.boolean().optional(),
  canSignWaivers: z.boolean().optional(),
  canReceiveEmails: z.boolean().optional(),
  makePrimary: z.boolean().optional(),
});

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "members", "full");
  if (denied) return denied;

  const member = await requireMember(id, session.user.clubId);
  if (!member) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let data: z.infer<typeof patchSchema>;
  try {
    data = patchSchema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  const link = await prisma.memberGuardianUser.findFirst({
    where: { id: data.linkId, memberId: id, clubId: session.user.clubId },
    select: {
      id: true, relationship: true, canBook: true, canPay: true,
      canSignWaivers: true, canReceiveEmails: true, isPrimary: true,
      user: { select: { firstName: true, lastName: true, email: true } },
    },
  });
  if (!link) return NextResponse.json({ error: "Link not found." }, { status: 404 });

  const changes: string[] = [];
  const field = <T,>(name: string, next: T | undefined, prev: T) => {
    if (next !== undefined && next !== prev) changes.push(`${name}: ${String(prev)} → ${String(next)}`);
  };
  field("relationship", data.relationship ?? undefined, link.relationship);
  field("canBook", data.canBook, link.canBook);
  field("canPay", data.canPay, link.canPay);
  field("canSignWaivers", data.canSignWaivers, link.canSignWaivers);
  field("canReceiveEmails", data.canReceiveEmails, link.canReceiveEmails);

  await prisma.memberGuardianUser.update({
    where: { id: link.id },
    data: {
      ...(data.relationship !== undefined ? { relationship: data.relationship } : {}),
      ...(data.canBook !== undefined ? { canBook: data.canBook } : {}),
      ...(data.canPay !== undefined ? { canPay: data.canPay } : {}),
      ...(data.canSignWaivers !== undefined ? { canSignWaivers: data.canSignWaivers } : {}),
      ...(data.canReceiveEmails !== undefined ? { canReceiveEmails: data.canReceiveEmails } : {}),
    },
  });

  // Exactly one primary per member — demote the rest in the same transaction so
  // a failed second write can't leave two.
  if (data.makePrimary && !link.isPrimary) {
    await prisma.$transaction([
      prisma.memberGuardianUser.updateMany({ where: { memberId: id }, data: { isPrimary: false } }),
      prisma.memberGuardianUser.update({ where: { id: link.id }, data: { isPrimary: true } }),
    ]);
    changes.push("set as primary guardian");
  }

  if (changes.length) {
    const who = `${link.user.firstName ?? ""} ${link.user.lastName ?? ""}`.trim() || link.user.email || "";
    await logAccessChange({
      clubId: session.user.clubId,
      memberId: id,
      actorUserId: session.user.id,
      message: `Guardian access UPDATED for ${who} <${link.user.email}> — ${changes.join("; ")}.`,
    });
  }

  return NextResponse.json({ ok: true, changed: changes });
}

export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "members", "full");
  if (denied) return denied;

  const member = await requireMember(id, session.user.clubId);
  if (!member) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const linkId = new URL(req.url).searchParams.get("linkId");
  if (!linkId) return NextResponse.json({ error: "linkId required" }, { status: 400 });

  const link = await prisma.memberGuardianUser.findFirst({
    where: { id: linkId, memberId: id, clubId: session.user.clubId, ...ACTIVE_GUARDIAN_LINK },
    select: {
      id: true, isPrimary: true,
      user: { select: { firstName: true, lastName: true, email: true } },
    },
  });
  if (!link) return NextResponse.json({ error: "Link not found." }, { status: 404 });

  // REVOKE, never delete. The row is the evidence that access once existed and
  // when it ended — deleting it destroys exactly the trail an incident needs.
  await prisma.memberGuardianUser.update({
    where: { id: link.id },
    data: { status: GUARDIAN_LINK_STATUS.REVOKED, revokedAt: new Date(), isPrimary: false },
  });

  // If the revoked guardian was primary, someone else must become primary or
  // the family loses the ability to edit its own controls.
  if (link.isPrimary) await ensurePrimaryGuardian(id);

  const who = `${link.user.firstName ?? ""} ${link.user.lastName ?? ""}`.trim() || link.user.email || "";
  await logAccessChange({
    clubId: session.user.clubId,
    memberId: id,
    actorUserId: session.user.id,
    message:
      `Guardian access REVOKED for ${who} <${link.user.email}>. ` +
      `The link row is kept with status=REVOKED; it no longer grants any access.` +
      `${link.isPrimary ? " They were the primary guardian; primary reassigned to the earliest remaining link." : ""}`,
  });

  return NextResponse.json({ ok: true });
}
