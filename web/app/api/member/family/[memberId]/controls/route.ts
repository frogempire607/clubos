import { NextResponse } from "next/server";
import { guardianActionBlocked, CONSENT_BLOCK_BODY } from "@/lib/parentalConsent";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { normalizeEmail, normalizePhone } from "@/lib/memberValidation";
import { isPrimaryGuardian } from "@/lib/guardianLink";
import { ACTIVE_GUARDIAN_LINK } from "@/lib/familyAccess";

// Parent-controls API. Scoped to GUARDIAN sessions only — the parent
// opens it for one of their linked minor children. We never let a
// minor edit their own controls (that would defeat the point).
//
// Guardian check: load the signed-in user's `guardianOf` relation
// (MemberGuardianUser rows) and confirm the requested memberId is
// among them. Mirrors the same pattern /api/member/documents uses.

async function loadGuardianChild(userId: string, memberId: string, clubId: string) {
  const viewer = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      guardianOf: {
        where: ACTIVE_GUARDIAN_LINK,
        select: {
          member: {
            select: {
              id: true,
              clubId: true,
              firstName: true,
              lastName: true,
              isMinor: true,
              birthdayLockedAt: true,
              parentControls: true,
              dateOfBirth: true,
              userId: true,
              email: true,
              phone: true,
              stripeCustomerId: true,
              stripeSetupCustomerId: true,
            },
          },
        },
      },
    },
  });
  if (!viewer) return null;
  const link = viewer.guardianOf.find((g) => g.member.id === memberId);
  if (!link) return null;
  if (link.member.clubId !== clubId) return null;
  return link.member;
}

// GET /api/member/family/[memberId]/controls
//   Returns the child's parental-control state for the parent to render.
export async function GET(_req: Request, context: { params: Promise<{ memberId: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const child = await loadGuardianChild(session.user.id, params.memberId, session.user.clubId);
  if (!child) return NextResponse.json({ error: "Not a linked child" }, { status: 403 });

  // COPPA: don't surface a minor's profile/controls to a guardian until consent is on file.
  if (await guardianActionBlocked(session.user.id, child.id)) {
    return NextResponse.json(CONSENT_BLOCK_BODY, { status: 403 });
  }

  // Everyone who can manage this athlete, oldest link first. Additive,
  // read-only: the viewer is already an authorized guardian of the child, so
  // seeing who else co-manages them is exactly what the Co-Guardians card
  // needs. `isPrimary` mirrors lib/guardianLink.isPrimaryGuardian.
  const links = await prisma.memberGuardianUser.findMany({
    where: { ...ACTIVE_GUARDIAN_LINK, memberId: child.id },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
    select: {
      id: true,
      userId: true,
      relationship: true,
      isPrimary: true,
      canBook: true,
      canPay: true,
      canSignWaivers: true,
      canReceiveEmails: true,
      createdAt: true,
      user: {
        select: {
          id: true, firstName: true, lastName: true, email: true,
          memberProfile: { select: { profileImageUrl: true } },
        },
      },
    },
  });

  // 4C.4 — parents now see the SAME four permissions, with the SAME words, as
  // staff see on the dashboard. Two vocabularies for one concept is exactly the
  // drift that let the Lister family break: staff and parent each believed a
  // different control governed access.
  //
  // `isPrimary` is READ FROM THE COLUMN. It used to be re-derived here from
  // guardianEmail + link order — a second implementation of a rule that now
  // lives in the database, and one keyed on the very field that was wrong for
  // Cameron. The badge and the save-gate can no longer disagree.
  const guardians = links.map((l) => ({
    linkId: l.id,
    userId: l.userId,
    name: `${l.user.firstName} ${l.user.lastName}`.trim(),
    profileImageUrl: l.user.memberProfile?.profileImageUrl ?? null,
    relationship: l.relationship,
    isPrimary: l.isPrimary,
    isYou: l.userId === session.user.id,
    linkedAt: l.createdAt,
    canBook: l.canBook,
    canPay: l.canPay,
    canSignWaivers: l.canSignWaivers,
    canReceiveEmails: l.canReceiveEmails,
  }));

  return NextResponse.json({
    guardians,
    member: {
      id: child.id,
      firstName: child.firstName,
      lastName: child.lastName,
      isMinor: child.isMinor,
      dateOfBirth: child.dateOfBirth,
      email: child.email,
      phone: child.phone,
    },
    birthdayLockedAt: child.birthdayLockedAt,
    parentControls: child.parentControls ?? null,
    // Whether this child already has their own portal login (so the page can
    // show "send invite" vs "has their own login").
    ownLogin: { hasLogin: !!child.userId, email: child.email ?? null },
    // Whether a Stripe billing account exists — the page hides "Manage billing"
    // for cash/check athletes so the button never 400s.
    hasBilling: !!(child.stripeSetupCustomerId || child.stripeCustomerId),
    // Co-guardians see everything but only the primary guardian may save
    // changes here or invite more guardians — lets the page render read-only.
    isPrimaryGuardian: await isPrimaryGuardian(session.user.id, child.id),
  });
}

const patchSchema = z.object({
  birthdayLocked: z.boolean().optional(),
  parentControls: z
    .object({
      requirePaymentApproval: z.boolean().optional(),
      monitoredMessaging:     z.boolean().optional(),
      allowPackagePurchase:   z.boolean().optional(),
      allowOwnMessaging:      z.boolean().optional(),
      dailySpendLimit:        z.number().nonnegative().optional(),
    })
    .nullable()
    .optional(),
  // Parent-editable athlete details (#12). The guardian may update the child's
  // name, DOB, and own contact. Contact is optional for minors (guardian
  // contact lives elsewhere). The guardian can edit DOB even when locked — the
  // lock only stops the CHILD from editing it.
  profile: z
    .object({
      firstName:   z.string().trim().min(1).max(100).optional(),
      lastName:    z.string().trim().max(100).optional(),
      dateOfBirth: z.string().trim().nullable().optional(), // "YYYY-MM-DD" or null
      email:       z.string().trim().nullable().optional(),
      phone:       z.string().trim().nullable().optional(),
    })
    .optional(),
  // 4C.4 — the primary guardian may adjust what each CO-guardian can do for
  // this athlete. Same four flags, same words, as the staff grid.
  guardianAccess: z
    .object({
      linkId:           z.string().min(1),
      canBook:          z.boolean().optional(),
      canPay:           z.boolean().optional(),
      canSignWaivers:   z.boolean().optional(),
      canReceiveEmails: z.boolean().optional(),
    })
    .optional(),
});

// PATCH /api/member/family/[memberId]/controls
//   Update the child's parental-control state. Guardian gate like GET, PLUS
//   primary-guardian only: co-guardians get full day-to-day access (viewing,
//   booking, billing) but only the first/official guardian sets the rules.
export async function PATCH(req: Request, context: { params: Promise<{ memberId: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const child = await loadGuardianChild(session.user.id, params.memberId, session.user.clubId);
  if (!child) return NextResponse.json({ error: "Not a linked child" }, { status: 403 });

  // COPPA: block editing a minor's profile/controls until consent is on file.
  if (await guardianActionBlocked(session.user.id, child.id)) {
    return NextResponse.json(CONSENT_BLOCK_BODY, { status: 403 });
  }

  if (!(await isPrimaryGuardian(session.user.id, child.id))) {
    return NextResponse.json(
      { error: "Only the primary guardian can change this athlete's settings and controls." },
      { status: 403 },
    );
  }

  try {
    const data = patchSchema.parse(await req.json());

    // ── Co-guardian permissions ──────────────────────────────────────────────
    // Only the primary guardian reaches here (gate above). Two further rules:
    // the link must belong to THIS child, and nobody may edit their own row —
    // otherwise a co-guardian promoted to primary could quietly grant
    // themselves back anything the previous primary removed.
    if (data.guardianAccess) {
      const ga = data.guardianAccess;
      const target = await prisma.memberGuardianUser.findFirst({
        where: { id: ga.linkId, memberId: child.id, ...ACTIVE_GUARDIAN_LINK },
        select: { id: true, userId: true, isPrimary: true },
      });
      if (!target) {
        return NextResponse.json({ error: "That guardian isn't linked to this athlete." }, { status: 404 });
      }
      if (target.userId === session.user.id) {
        return NextResponse.json(
          { error: "You can't change your own access. Ask the club if it needs to change." },
          { status: 403 },
        );
      }
      await prisma.memberGuardianUser.update({
        where: { id: target.id },
        data: {
          ...(ga.canBook !== undefined ? { canBook: ga.canBook } : {}),
          ...(ga.canPay !== undefined ? { canPay: ga.canPay } : {}),
          ...(ga.canSignWaivers !== undefined ? { canSignWaivers: ga.canSignWaivers } : {}),
          ...(ga.canReceiveEmails !== undefined ? { canReceiveEmails: ga.canReceiveEmails } : {}),
        },
      });
      // Staff must be able to see a parent changing another parent's access.
      await prisma.memberMigrationEvent.create({
        data: {
          clubId: session.user.clubId,
          memberId: child.id,
          type: "NOTE",
          actorUserId: session.user.id,
          message:
            `Primary guardian updated co-guardian access for link ${target.id}: ` +
            Object.entries(ga)
              .filter(([k]) => k !== "linkId")
              .map(([k, v]) => `${k}=${v}`)
              .join(", ") + ".",
        },
      });
    }

    const update: Prisma.MemberUncheckedUpdateInput = {};
    if (data.birthdayLocked !== undefined) {
      update.birthdayLockedAt = data.birthdayLocked ? new Date() : null;
    }
    if (data.parentControls !== undefined) {
      update.parentControls =
        data.parentControls === null
          ? Prisma.JsonNull
          : (data.parentControls as Prisma.InputJsonValue);
    }

    // Parent-editable athlete details (#12).
    if (data.profile) {
      const p = data.profile;
      if (p.firstName !== undefined) update.firstName = p.firstName;
      if (p.lastName !== undefined) update.lastName = p.lastName;
      if (p.email !== undefined) {
        if (p.email === null || p.email === "") {
          update.email = null;
        } else {
          const e = normalizeEmail(p.email);
          if (!e) return NextResponse.json({ error: "Enter a valid email." }, { status: 400 });
          update.email = e;
        }
      }
      if (p.phone !== undefined) update.phone = p.phone ? normalizePhone(p.phone) : null;
      if (p.dateOfBirth !== undefined) {
        if (!p.dateOfBirth) {
          update.dateOfBirth = null;
        } else {
          // Store as UTC midnight so the displayed day matches what was entered
          // (the portal renders DOB with timeZone:"UTC").
          const d = new Date(`${p.dateOfBirth}T00:00:00.000Z`);
          if (Number.isNaN(d.getTime())) {
            return NextResponse.json({ error: "Enter a valid date of birth." }, { status: 400 });
          }
          update.dateOfBirth = d;
        }
      }
    }

    await prisma.member.update({
      where: { id: child.id },
      data: update,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors[0]?.message ?? "Invalid input" }, { status: 400 });
    }
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }
}
