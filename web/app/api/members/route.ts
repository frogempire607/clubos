import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { MEMBER_ORIGIN } from "@/lib/memberOrigin";
import { getTierFeatures, getTierName } from "@/lib/tier";
import { upsertGuardianProfile } from "@/lib/guardian";
import { ensurePrimaryGuardian } from "@/lib/guardianLink";
import { expireEndedManualSubscriptions } from "@/lib/memberStatus";
import { getAppBaseUrl } from "@/lib/baseUrl";
import { validateMemberContact } from "@/lib/memberValidation";
import { ACTIVE_GUARDIAN_LINK } from "@/lib/familyAccess";
import { listMembers, parseMemberFilters } from "@/lib/membersQuery";

/**
 * Phase 4.5.2 — the new roster payload. Opt-in via `?paginated=1`; see the note
 * in GET for why the default shape is unchanged.
 */
async function listMembersPaginated(req: Request, clubId: string) {
  const filters = parseMemberFilters(new URL(req.url));
  // D-3's four work-queue counts ride along inside listMembers (`queueCounts`),
  // built from the same predicates the cards apply — see countQueues.
  const result = await listMembers(clubId, filters);
  return NextResponse.json(result);
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const guardianEmail = url.searchParams.get("guardianEmail");

  // ── Phase 4.5.2 ──────────────────────────────────────────────────────────
  // `?paginated=1` opts into the new envelope: server-side paging, search,
  // filters, derived tracks, one nextAction per row, and segment counts taken
  // from the QUERY rather than the loaded page.
  //
  // Without the flag this route returns the legacy bare array, unchanged. That
  // is deliberate rather than lazy: /dashboard/members/migration, the
  // attendance add-panel, the duplicates page and several modals all consume
  // this endpoint and index it as an array. Switching the default shape would
  // break every one of them in the same commit.
  if (url.searchParams.get("paginated") === "1") {
    return listMembersPaginated(req, session.user.clubId);
  }

  // Self-heal: lazily flip prospects older than the TTL to INACTIVE.
  // Lazily expire ended MANUAL non-renewing subscriptions (final-period-paid
  // members past their end date) so ACTIVE always means a live membership.
  // The old prospect-TTL decay was removed: prospects never auto-age to
  // INACTIVE — INACTIVE is reserved for members whose membership ended.
  await expireEndedManualSubscriptions(session.user.clubId);

  const members = await prisma.member.findMany({
    where: {
      clubId: session.user.clubId,
      deletedAt: null,
      ...(guardianEmail
        ? {
            OR: [
              { guardianEmail: guardianEmail.toLowerCase() },
              { guardian: { email: guardianEmail.toLowerCase() } },
            ],
          }
        : {}),
    },
    orderBy: { createdAt: "desc" },
    include: {
      membership: { select: { name: true } },
      subscriptions: {
        // include pending so the list can surface a "purchase in progress" state
        where: { status: { in: ["active", "past_due", "pending"] } },
        include: { membership: { select: { name: true } } },
      },
      guardian: true,
      // Cheap existence probe: one linked guardian portal user is enough for
      // the roster's "Profile completed" derivation (minors whose guardian
      // registered count as completed even without their own login).
      guardianLinks: { where: ACTIVE_GUARDIAN_LINK, select: { id: true }, take: 1 },
    },
  });

  // Additive payload field: hasGuardianAccount = the member has ≥1
  // MemberGuardianUser row. The raw link rows themselves aren't needed
  // client-side, so map them down to the boolean.
  return NextResponse.json(
    members.map(({ guardianLinks, ...m }) => ({
      ...m,
      hasGuardianAccount: guardianLinks.length > 0,
    }))
  );
}

const createSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email().optional().nullable().or(z.literal("")),
  phone: z.string().optional().nullable(),
  dateOfBirth: z.string().optional(),
  status: z.enum(["ACTIVE", "PROSPECT", "INACTIVE", "PAUSED"]).default("PROSPECT"),
  tags: z.string().optional(),
  notes: z.string().optional(),
  streetAddress: z.string().optional().nullable(),
  city:          z.string().optional().nullable(),
  state:         z.string().optional().nullable(),
  zipCode:       z.string().optional().nullable(),
  gender: z.string().optional().nullable(),
  customFieldValues: z.record(z.string()).optional(),
  isMinor: z.boolean().default(false),
  guardianName: z.string().optional(),
  guardianEmail: z.string().email().optional().nullable().or(z.literal("")),
  guardianPhone: z.string().optional().nullable(),
  guardianRelationship: z.string().optional().nullable(),
  profileImageUrl: z.string().optional().nullable(),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "members", "edit");
  if (denied) return denied;

  try {
    const body = await req.json();
    const data = createSchema.parse(body);

    // ── Tier gating: Growth caps at 200 members; Pro/Enterprise unlimited ──
    const club = await prisma.club.findUnique({
      where: { id: session.user.clubId },
      select: { tier: true },
    });
    const features = getTierFeatures(club?.tier ?? "growth");
    if (features.maxMembers !== null) {
      const count = await prisma.member.count({
        where: { clubId: session.user.clubId, deletedAt: null },
      });
      if (count >= features.maxMembers) {
        return NextResponse.json(
          {
            error: `Your ${getTierName(club?.tier ?? "growth")} plan allows up to ${features.maxMembers} members. Upgrade to Pro for unlimited members.`,
            code: "MEMBER_LIMIT_REACHED",
            upgradeRequired: "pro",
          },
          { status: 403 }
        );
      }
    }

    // Prevent duplicate Member records with the same email in the same club
    if (data.email) {
      const emailConflict = await prisma.member.findFirst({
        where: {
          clubId: session.user.clubId,
          email: data.email.toLowerCase(),
          deletedAt: null,
        },
      });
      if (emailConflict) {
        return NextResponse.json(
          { error: `A member with email ${data.email} already exists in this club.` },
          { status: 409 }
        );
      }
    }

    // Minors are reached through their guardian; adult members need their own
    // contact path. A minor's OWN email/phone are optional and may be null.
    const contactError = validateMemberContact({
      isMinor: data.isMinor,
      email: data.email,
      phone: data.phone,
      guardianName: data.guardianName,
      guardianEmail: data.guardianEmail,
    });
    if (contactError) {
      return NextResponse.json({ error: contactError }, { status: 400 });
    }

    // Upsert Guardian profile when guardian info is provided (always for minors,
    // optional for adults). Siblings sharing the same guardian email link to the
    // same Guardian profile.
    const guardian = await upsertGuardianProfile(session.user.clubId, {
      guardianName: data.guardianName,
      guardianEmail: data.guardianEmail,
      guardianPhone: data.guardianPhone,
    });

    // A brand-new member can't yet have an active subscription, so we never
    // create them as ACTIVE. They become ACTIVE later via the Stripe webhook
    // (or manual subscription assignment) once a subscription kicks in.
    const initialStatus = data.status === "ACTIVE" ? "PROSPECT" : data.status;

    const member = await prisma.member.create({
      data: {
        clubId: session.user.clubId,
        createdVia: MEMBER_ORIGIN.STAFF,
        firstName: data.firstName,
        lastName: data.lastName,
        email: data.email ? data.email.toLowerCase() : null,
        phone: data.phone || null,
        dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : null,
        status: initialStatus,
        tags: data.tags || "",
        notes: data.notes || null,
        streetAddress: data.streetAddress || null,
        city:          data.city || null,
        state:         data.state || null,
        zipCode:       data.zipCode || null,
        gender: data.gender || null,
        customFieldValues: JSON.stringify(data.customFieldValues || {}),
        isMinor: data.isMinor,
        guardianId: guardian?.id ?? null,
        guardianName: data.guardianName || null,
        guardianEmail: data.guardianEmail ? data.guardianEmail.toLowerCase() : null,
        guardianPhone: data.guardianPhone || null,
        guardianRelationship: data.guardianRelationship || null,
        profileImageUrl: data.profileImageUrl || null,
      },
    });

    // Owner-vouched guardian link: if a portal account already exists for the
    // guardian's email, link them to this child right away so it appears in
    // their portal. The owner adding the child IS the approval, so no separate
    // guardian-link request is needed. (Fixes: manually adding a 2nd child not
    // showing up for the guardian.)
    if (member.isMinor && member.guardianEmail) {
      const guardianUser = await prisma.user.findFirst({
        where: { clubId: session.user.clubId, email: member.guardianEmail, deletedAt: null },
        select: { id: true },
      });
      if (guardianUser) {
        await prisma.memberGuardianUser.upsert({
          where: { userId_memberId: { userId: guardianUser.id, memberId: member.id } },
          update: {},
          create: {
            clubId: session.user.clubId,
            userId: guardianUser.id,
            memberId: member.id,
            relationship: data.guardianRelationship || null,
            status: "CONFIRMED",
            source: "OWNER_VOUCHED",
            createdByUserId: session.user.id,
            confirmedAt: new Date(),
          },
        });
        await ensurePrimaryGuardian(member.id);
      }
    }

    // Fire-and-forget welcome email so the member (or guardian for minors) can set
    // up portal access. Skips silently if no email is on file.
    const portalRecipient = data.isMinor
      ? (data.guardianEmail || data.email || null)
      : (data.email || data.guardianEmail || null);
    if (portalRecipient) {
      try {
        const club = await prisma.club.findUnique({
          where: { id: session.user.clubId },
          select: { name: true },
        });
        const { sendWelcomeEmail } = await import("@/lib/email");
        const baseUrl = getAppBaseUrl();
        await sendWelcomeEmail({
          to: portalRecipient.toLowerCase(),
          firstName: data.isMinor ? (data.guardianName?.split(" ")[0] || "there") : data.firstName,
          clubName: club?.name ?? "your club",
          loginUrl: `${baseUrl}/member/signup`,
        });
      } catch (emailErr) {
        console.error("Member welcome email failed:", emailErr);
      }
    }

    return NextResponse.json(member, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.flatten() }, { status: 400 });
    }
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
