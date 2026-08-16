import { NextResponse } from "next/server";
import { z } from "zod";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { rateLimit, rateLimitedResponse, ipFromRequest } from "@/lib/ratelimit";
import { requestGuardianLink, ensurePrimaryGuardian } from "@/lib/guardianLink";
import { GUARDIAN_LINK_SOURCE } from "@/lib/familyAccess";
import { missingRequiredDocumentIds, requiredDocumentSurfaceWhere } from "@/lib/documents";
import { normalizeFreeTrialConfig, trialWindowDays } from "@/lib/freeTrial";
import { createGuardianConsentRequest, recordParentalConsent } from "@/lib/parentalConsent";
import { sendGuardianConsentRequestEmail } from "@/lib/email";
import { getAppBaseUrl } from "@/lib/baseUrl";
import { isMinorAge } from "@/lib/age";
import {
  planSignup,
  trialTargetFor,
  trialBlockedBySelfGuardian,
  normalizeEmail,
  type SignupPlan,
} from "@/lib/signupIntent";

const schema = z.object({
  clubSlug: z.string().min(1),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
  accountType: z.enum(["ADULT_ATHLETE", "MINOR_ATHLETE", "MINOR_SELF", "PARENT"]),
  dateOfBirth: z.string().optional(),
  // §7.2 — the modern child path. When these are present, `firstName`/
  // `lastName`/`email` describe the GUARDIAN (the account holder) and these
  // describe the athlete. Their presence is how the route knows which of the
  // two minor shapes it is looking at.
  childFirstName: z.string().optional(),
  childLastName: z.string().optional(),
  // Guardian info. Sent by a SELF-SIGNING MINOR naming their parent — the
  // juniors and seniors who sign up with their own email. The guardian path
  // derives the guardian from the account holder and sends none of this except
  // phone/relationship.
  guardianName: z.string().optional(),
  guardianEmail: z.string().email().optional().or(z.literal("")),
  guardianPhone: z.string().optional(),
  guardianRelationship: z.string().optional(),
  // Parent fields (for PARENT — link to child's member record)
  childEmail: z.string().email().optional().or(z.literal("")),
  relationship: z.string().optional(),
  // Consent — must be exactly true. Rejects undefined/false/"true".
  acceptedTerms: z.literal(true),
  termsVersion: z.string().min(1),
  privacyVersion: z.string().min(1),
  signedDocumentIds: z.array(z.string()).optional().default([]),
  // A PARENT signing up may explicitly consent for the child they link.
  parentalConsent: z.boolean().optional(),
  // Came from the club's public free-trial link (?trial=1). Server-validated
  // against Club.freeTrialConfig — the flag alone grants nothing.
  requestTrial: z.boolean().optional().default(false),
});

export async function GET(req: Request) {
  const url = new URL(req.url);
  const clubSlug = url.searchParams.get("clubSlug")?.trim().toLowerCase();
  if (!clubSlug) return NextResponse.json({ error: "clubSlug is required" }, { status: 400 });

  const club = await prisma.club.findUnique({
    where: { slug: clubSlug },
    select: { id: true, name: true, slug: true, freeTrialConfig: true },
  });
  if (!club) return NextResponse.json({ error: "Club not found" }, { status: 404 });
  // Advertised on the trial signup link (?trial=1) — name + length only.
  const trialConfig = normalizeFreeTrialConfig(club.freeTrialConfig);
  const freeTrial = trialConfig?.active ? { name: trialConfig.name, days: trialConfig.days } : null;

  const now = new Date();
  const documents = await prisma.document.findMany({
    where: {
      clubId: club.id,
      deletedAt: null,
      AND: [
        requiredDocumentSurfaceWhere("SIGNUP"),
        { OR: [{ publishAt: null }, { publishAt: { lte: now } }] },
        { OR: [{ unpublishAt: null }, { unpublishAt: { gt: now } }] },
        { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      ],
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      title: true,
      type: true,
      body: true,
      required: true,
      requiredAt: true,
      requiresGuardianSignature: true,
    },
  });

  return NextResponse.json({ club: { id: club.id, name: club.name, slug: club.slug }, documents, freeTrial });
}

export async function POST(req: Request) {
  // 10 member signups per 10 minutes per IP. A family signing up
  // multiple kids in a row is realistic; bot-scripted account creation
  // gets blocked.
  const rl = rateLimit({ key: `auth:member-signup:${ipFromRequest(req)}`, limit: 10, windowMs: 10 * 60_000 });
  if (!rl.allowed) return rateLimitedResponse(rl, "Too many signups from this device. Try again in a few minutes.");

  try {
    const data = schema.parse(await req.json());

    const club = await prisma.club.findUnique({ where: { slug: data.clubSlug } });
    if (!club) {
      return NextResponse.json({ error: "Club not found. Check the club URL and try again." }, { status: 404 });
    }

    const signupDocs = await prisma.document.findMany({
      where: {
        clubId: club.id,
        deletedAt: null,
        AND: [
          requiredDocumentSurfaceWhere("SIGNUP"),
          { OR: [{ publishAt: null }, { publishAt: { lte: new Date() } }] },
          { OR: [{ unpublishAt: null }, { unpublishAt: { gt: new Date() } }] },
          { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        ],
      },
      select: { id: true, title: true, required: true, requiredAt: true, requiresGuardianSignature: true },
    });
    const missingDocIds = missingRequiredDocumentIds(signupDocs, data.signedDocumentIds, "SIGNUP");
    if (missingDocIds.length > 0) {
      const titles = signupDocs
        .filter((doc) => missingDocIds.includes(doc.id))
        .map((doc) => doc.title)
        .join(", ");
      return NextResponse.json(
        { error: `Please review and acknowledge all required signup documents${titles ? `: ${titles}` : ""}.` },
        { status: 400 },
      );
    }

    // §7.2 — decide WHAT this submission may create before creating anything.
    // This is where AJ Dorn's shape is refused: one address may not be both the
    // account being created and that account's athlete's guardian.
    const planned = planSignup({
      intent: data.accountType,
      accountEmail: data.email,
      accountFirstName: data.firstName,
      accountLastName: data.lastName,
      dateOfBirth: data.dateOfBirth,
      childFirstName: data.childFirstName,
      childLastName: data.childLastName,
      guardianEmail: data.guardianEmail || null,
      guardianName: data.guardianName || null,
    });
    if (!planned.ok) {
      return NextResponse.json({ error: planned.error, code: planned.code }, { status: 400 });
    }
    const plan: SignupPlan = planned.plan;

    // COPPA: on the child path the guardian is right here, so consent is given
    // in-session rather than round-tripped through an email. Refuse before any
    // write — a child record must never exist without a consent decision.
    if (plan.kind === "CHILD_BY_GUARDIAN" && data.parentalConsent !== true) {
      return NextResponse.json(
        {
          error: "Please confirm you're the parent or legal guardian of this athlete.",
          code: "PARENTAL_CONSENT_REQUIRED",
        },
        { status: 400 },
      );
    }

    // Check for existing user account in this club
    const existing = await prisma.user.findUnique({
      where: { clubId_email: { clubId: club.id, email: data.email.toLowerCase() } },
    });
    if (existing && !existing.deletedAt) {
      return NextResponse.json({ error: "An account with this email already exists. Try logging in." }, { status: 409 });
    }

    const passwordHash = await bcrypt.hash(data.password, 12);
    // Whether the ACCOUNT HOLDER is a minor athlete. `planSignup` decided this
    // from the DATE OF BIRTH, not from which option was clicked, so this agrees
    // with `resolveIsMinor` at the login gate rather than contradicting it.
    // On the guardian path the account holder is the guardian — an adult — and
    // the minor is the separate child Member created below.
    const isMinor = plan.kind === "MINOR_SELF";

    // Find existing Member record by email (case-insensitive via stored lowercase) to link up
    const existingMember = await prisma.member.findFirst({
      where: { clubId: club.id, email: data.email.toLowerCase(), deletedAt: null },
    });

    // If that Member record is already claimed by a different User, block signup
    if (existingMember?.userId && existingMember.userId !== null) {
      const claimingUser = await prisma.user.findUnique({
        where: { id: existingMember.userId },
        select: { deletedAt: true },
      });
      if (claimingUser && !claimingUser.deletedAt) {
        return NextResponse.json(
          { error: "A portal account for this email is already active. Try logging in instead." },
          { status: 409 }
        );
      }
    }

    // When a SOFT-DELETED login already occupies this (clubId, email) — e.g. the
    // member was deleted and is signing up again — RESURRECT it instead of
    // creating a new row. The (clubId, email) unique index is GLOBAL (it ignores
    // deletedAt), so a plain create would throw a unique violation and 500. A
    // soft-deleted login has no active credentials, so clearing deletedAt and
    // setting the new password here is safe (we already 409'd above if a LIVE
    // account exists). Member-profile linkage is identical in both paths.
    const user = existing
      ? await prisma.user.update({
          where: { id: existing.id },
          data: {
            passwordHash,
            deletedAt: null,
            firstName: data.firstName,
            lastName: data.lastName,
            role: "MEMBER",
            resetToken: null,
            resetExpires: null,
            ...(existingMember
              ? {
                  memberProfile: { connect: { id: existingMember.id } },
                }
              : !plan.accountIsAthlete
                ? {
                    // GUARDIAN-ONLY account: a parent creating a portal login
                    // to manage a child is NOT an athlete/member — no Member
                    // row is created. They can add an adult member profile
                    // later (self-profile) or staff can add one explicitly.
                    // On the CHILD_BY_GUARDIAN path the athlete is created
                    // below as a SEPARATE Member with `userId: null`, which is
                    // what makes a self-guardian link impossible.
                  }
                : {
                    memberProfile: {
                      create: {
                        clubId: club.id,
                        firstName: data.firstName,
                        lastName: data.lastName,
                        email: data.email.toLowerCase(),
                        // Signing up NEVER makes someone Active — ACTIVE means
                        // a valid membership exists. New signups are PROSPECT
                        // until they purchase / are assigned a membership.
                        status: "PROSPECT",
                        isMinor,
                        dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : null,
                        guardianName: data.guardianName || null,
                        guardianEmail: data.guardianEmail || null,
                        guardianPhone: data.guardianPhone || null,
                        guardianRelationship: data.guardianRelationship || null,
                      },
                    },
                  }),
          },
          include: { memberProfile: true },
        })
      : await prisma.user.create({
          data: {
            clubId: club.id,
            email: data.email.toLowerCase(),
            passwordHash,
            firstName: data.firstName,
            lastName: data.lastName,
            role: "MEMBER",
            ...(existingMember
              ? {
                  memberProfile: { connect: { id: existingMember.id } },
                }
              : !plan.accountIsAthlete
                ? {
                    // GUARDIAN-ONLY account: a parent creating a portal login
                    // to manage a child is NOT an athlete/member — no Member
                    // row is created. They can add an adult member profile
                    // later (self-profile) or staff can add one explicitly.
                    // On the CHILD_BY_GUARDIAN path the athlete is created
                    // below as a SEPARATE Member with `userId: null`, which is
                    // what makes a self-guardian link impossible.
                  }
                : {
                    memberProfile: {
                      create: {
                        clubId: club.id,
                        firstName: data.firstName,
                        lastName: data.lastName,
                        email: data.email.toLowerCase(),
                        // Signing up NEVER makes someone Active — ACTIVE means
                        // a valid membership exists. New signups are PROSPECT
                        // until they purchase / are assigned a membership.
                        status: "PROSPECT",
                        isMinor,
                        dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : null,
                        guardianName: data.guardianName || null,
                        guardianEmail: data.guardianEmail || null,
                        guardianPhone: data.guardianPhone || null,
                        guardianRelationship: data.guardianRelationship || null,
                      },
                    },
                  }),
          },
          include: { memberProfile: true },
        });

    // ── §7.2 — the athlete the guardian just signed up ───────────────────────
    // Two rows, two jobs: the User above is the GUARDIAN's login, this Member
    // is the CHILD, and they are joined by a guardian link. The child holds no
    // `userId`, so the account can never end up as its own guardian no matter
    // what the email lookup later finds.
    let createdChild: { id: string; firstName: string; lastName: string } | null = null;
    if (plan.kind === "CHILD_BY_GUARDIAN") {
      const guardianFullName = `${data.firstName} ${data.lastName}`.trim();
      const guardianEmail = normalizeEmail(data.email);

      const guardianProfile = await prisma.guardian.upsert({
        where: { clubId_email: { clubId: club.id, email: guardianEmail } },
        update: { firstName: data.firstName, lastName: data.lastName, userId: user.id },
        create: {
          clubId: club.id,
          firstName: data.firstName,
          lastName: data.lastName,
          email: guardianEmail,
          phone: data.guardianPhone || "",
          userId: user.id,
        },
      });

      createdChild = await prisma.member.create({
        data: {
          clubId: club.id,
          firstName: plan.child.firstName,
          // A parent who types only a first name gets the family surname.
          lastName: plan.child.lastName || data.lastName,
          // The child has NO login and NO contact of their own. That is the
          // centralized minor-contact rule (lib/memberValidation.ts), and it
          // also keeps this record out of shape C — a parent's address sitting
          // on the child row, the precondition that turned signups into
          // self-guardians in the first place.
          email: null,
          status: "PROSPECT",
          // Derived from the DOB, not assumed from the path. A guardian may
          // legitimately manage a 19-year-old's account, and storing that
          // athlete as a minor would contradict `resolveIsMinor` everywhere
          // else — age brackets, waivers, the login gate.
          isMinor: isMinorAge(data.dateOfBirth),
          dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : null,
          guardianId: guardianProfile.id,
          guardianName: guardianFullName,
          guardianEmail,
          guardianPhone: data.guardianPhone || null,
          guardianRelationship: data.guardianRelationship || "Parent",
        },
        select: { id: true, firstName: true, lastName: true },
      });

      await prisma.memberGuardianUser.create({
        data: {
          clubId: club.id,
          userId: user.id,
          memberId: createdChild.id,
          relationship: data.guardianRelationship || "Parent",
          // CONFIRMED without an owner approval is correct here and ONLY here:
          // the child record did not exist until this person typed it, so there
          // is no pre-existing athlete for them to claim by email.
          status: "CONFIRMED",
          source: GUARDIAN_LINK_SOURCE.CHILD_SIGNUP,
          confirmedAt: new Date(),
        },
      });
      await ensurePrimaryGuardian(createdChild.id);

      try {
        await recordParentalConsent(prisma, {
          clubId: club.id,
          memberId: createdChild.id,
          childUserId: null,
          guardianUserId: user.id,
          guardianName: guardianFullName,
          guardianEmail,
          relationship: data.guardianRelationship || "Parent",
          clubName: club.name,
          childName: `${createdChild.firstName} ${createdChild.lastName}`.trim(),
          ipAddress: ipFromRequest(req),
          userAgent: req.headers.get("user-agent"),
          source: "SIGNUP",
        });
      } catch (e) {
        console.error("Failed to record parental consent (child-by-guardian signup):", e);
      }
    }

    // If PARENT — request guardian access to the child member. Access is
    // granted here ONLY when the owner already named this email as the
    // child's guardian (childMember.guardianEmail === signup email).
    // Otherwise it is queued for owner approval and NO access — and no
    // guardian-of-record — is established. This prevents an unauthenticated
    // signup from silently claiming any club-mate by email.
    let guardianLinkPending = false;
    let pendingGuardianConsent = false;
    if (data.accountType === "PARENT" && data.childEmail) {
      const childMember = await prisma.member.findFirst({
        where: { clubId: club.id, email: data.childEmail.toLowerCase(), deletedAt: null },
      });
      if (childMember) {
        const linkResult = await requestGuardianLink({
          clubId: club.id,
          requestingUserId: user.id,
          requestingUserEmail: data.email.toLowerCase(),
          child: { id: childMember.id, isMinor: childMember.isMinor, guardianEmail: childMember.guardianEmail },
          relationship: data.relationship || null,
        });

        if (linkResult.status === "linked") {
          // Owner-vouched parent: normalize a Guardian profile so this
          // parent's family can hold siblings, and stamp guardian-of-record.
          const guardianFullName = `${data.firstName} ${data.lastName}`.trim();
          const guardianEmail = data.email.toLowerCase();
          const guardianProfile = await prisma.guardian.upsert({
            where: { clubId_email: { clubId: club.id, email: guardianEmail } },
            update: {
              firstName: data.firstName,
              lastName: data.lastName,
              userId: user.id,
            },
            create: {
              clubId: club.id,
              firstName: data.firstName,
              lastName: data.lastName,
              email: guardianEmail,
              phone: childMember.guardianPhone || "",
              userId: user.id,
            },
          });
          await prisma.member.update({
            where: { id: childMember.id },
            data: {
              guardianId: guardianProfile.id,
              guardianName: childMember.guardianName || guardianFullName,
              guardianEmail: childMember.guardianEmail || guardianEmail,
            },
          });
        } else {
          // Queued — do NOT establish any guardian relationship yet.
          guardianLinkPending = true;
        }

        // Record the parent's explicit consent for this (minor) child when they
        // checked the consent box. Immutable audit row; portal access still
        // follows the link/approval rules above.
        if (childMember.isMinor && data.parentalConsent) {
          try {
            await recordParentalConsent(prisma, {
              clubId: club.id,
              memberId: childMember.id,
              childUserId: childMember.userId ?? null,
              guardianUserId: user.id,
              guardianName: `${data.firstName} ${data.lastName}`.trim(),
              guardianEmail: data.email.toLowerCase(),
              relationship: data.relationship || null,
              clubName: club.name,
              childName: `${childMember.firstName} ${childMember.lastName}`.trim(),
              ipAddress: ipFromRequest(req),
              userAgent: req.headers.get("user-agent"),
              source: "SIGNUP",
            });
          } catch (e) {
            console.error("Failed to record parental consent (member signup PARENT):", e);
          }
        }
      }
    }

    // A parent's portal account should immediately manage EVERY child the
    // club already lists under their email (guardianEmail match = owner-
    // vouched, same rule requestGuardianLink enforces) — not only the one
    // child they happened to type. This is how a manually-added child (e.g.
    // a walk-in added at practice with mom's email as guardian) gets linked
    // the moment mom creates her account, instead of staying orphaned.
    //
    // Runs for EVERY guardian-shaped account, not just PARENT: a parent
    // signing up their first child often already has an older sibling on the
    // roster from a CSV import, and that sibling should appear the moment the
    // account exists — not after they email the club asking why it doesn't.
    let sweptChildren = 0;
    if (!plan.accountIsAthlete) {
      const vouchedChildren = await prisma.member.findMany({
        where: {
          clubId: club.id,
          deletedAt: null,
          guardianEmail: { equals: data.email.toLowerCase(), mode: "insensitive" },
          ...(createdChild ? { id: { not: createdChild.id } } : {}),
          ...(data.childEmail ? { NOT: { email: data.childEmail.toLowerCase() } } : {}),
        },
        select: { id: true, isMinor: true, guardianEmail: true },
      });
      for (const child of vouchedChildren) {
        try {
          const swept = await requestGuardianLink({
            clubId: club.id,
            requestingUserId: user.id,
            requestingUserEmail: data.email.toLowerCase(),
            child: { id: child.id, isMinor: child.isMinor, guardianEmail: child.guardianEmail },
            relationship: data.relationship || null,
          });
          if (swept.status === "linked") sweptChildren++;
        } catch (e) {
          console.error("Guardian sweep link failed for child", child.id, e);
        }
      }
    }

    // Update existing member record with profile data if we linked it
    if (existingMember) {
      await prisma.member.update({
        where: { id: existingMember.id },
        data: {
          isMinor,
          guardianName: data.guardianName || existingMember.guardianName,
          guardianEmail: data.guardianEmail || existingMember.guardianEmail,
          guardianPhone: data.guardianPhone || existingMember.guardianPhone,
          guardianRelationship: data.guardianRelationship || existingMember.guardianRelationship,
        },
      });
    }

    // COPPA: a minor self-signup does NOT activate. Create a guardian consent
    // request and email the parent/guardian the consent link. The minor's own
    // login stays blocked (authorize()) until a guardian records consent.
    if (isMinor && user.memberProfile) {
      const guardianEmail = (data.guardianEmail || "").toLowerCase();

      // §7.2 — give the guardian their OWN account, right after the child's.
      // Before this, a teen signing up named a parent who had no login: consent
      // was recorded but `MemberGuardianUser` was never created (the consent
      // route can only link a guardian that already exists), so the child ended
      // up with no guardian at all. The account is created with an unusable
      // random secret plus a 14-day invite token — the same shape as a staff
      // setup link — so it can never be logged into until the guardian sets a
      // password themselves.
      let guardianSetupUrl: string | null = null;
      try {
        const existingGuardian = await prisma.user.findUnique({
          where: { clubId_email: { clubId: club.id, email: guardianEmail } },
          select: { id: true, deletedAt: true },
        });
        if (!existingGuardian || existingGuardian.deletedAt) {
          const inviteToken = crypto.randomBytes(32).toString("hex");
          const [gFirst, ...gRest] = (data.guardianName || "").trim().split(/\s+/).filter(Boolean);
          await prisma.user.upsert({
            where: { clubId_email: { clubId: club.id, email: guardianEmail } },
            update: {
              deletedAt: null,
              resetToken: inviteToken,
              resetExpires: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
            },
            create: {
              clubId: club.id,
              email: guardianEmail,
              passwordHash: await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 12),
              firstName: gFirst || "Parent",
              lastName: gRest.join(" ") || "/ Guardian",
              role: "MEMBER",
              resetToken: inviteToken,
              resetExpires: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
            },
          });
          guardianSetupUrl = `${getAppBaseUrl()}/reset-password?token=${inviteToken}`;
        }
      } catch (e) {
        // A guardian account is a convenience here — consent still works
        // without it. Never fail the signup over it.
        console.error("Failed to create guardian account for minor signup:", e);
      }

      try {
        const reqRow = await createGuardianConsentRequest(prisma, {
          clubId: club.id,
          memberId: user.memberProfile.id,
          guardianName: data.guardianName || null,
          guardianEmail,
          relationship: data.guardianRelationship || null,
          source: "SIGNUP",
        });
        pendingGuardianConsent = true;
        const consentUrl = `${getAppBaseUrl()}/guardian-consent/${reqRow.token}`;
        await sendGuardianConsentRequestEmail({
          to: guardianEmail,
          guardianName: data.guardianName,
          childName: `${data.firstName} ${data.lastName}`.trim(),
          clubName: club.name,
          consentUrl,
          setPasswordUrl: guardianSetupUrl,
        });
      } catch (e) {
        // The request row (if created) lets the owner resend later. Never break
        // signup on a consent-email failure.
        console.error("Failed to create/send guardian consent request:", e);
        pendingGuardianConsent = true;
      }
    }

    // Record terms/privacy consent — 2 rows per signup (TOS + PRIVACY).
    // Wrapped in try/catch so a consent-write failure can never block
    // the signup flow. Same shape as /api/auth/signup.
    try {
      await prisma.legalAcceptance.createMany({
        data: [
          {
            userId: user.id,
            clubId: club.id,
            documentType: "TOS",
            version: data.termsVersion,
            acceptedAt: new Date(),
            ipAddress: ipFromRequest(req),
            userAgent: req.headers.get("user-agent") || null,
          },
          {
            userId: user.id,
            clubId: club.id,
            documentType: "PRIVACY",
            version: data.privacyVersion,
            acceptedAt: new Date(),
            ipAddress: ipFromRequest(req),
            userAgent: req.headers.get("user-agent") || null,
          },
        ],
      });
    } catch (err) {
      console.error("Failed to persist legal acceptance (member signup):", err);
    }

    // ── §7.3 — the trial attaches to the ATHLETE, not to whoever filled in
    // the form. A trial is a class entitlement, so it belongs to the person who
    // attends the classes. On the child path that is the child; on a
    // guardian-only signup there is no athlete yet, and we now SAY so instead
    // of skipping the block in silence (the old code checked `user.memberProfile`
    // and a parent who clicked a trial link simply got nothing, with no message).
    //
    // Requires an explicitly ACTIVE Free Trial offer — a hand-crafted ?trial=1
    // URL on a club that never configured one grants nothing. A resurrected
    // profile that already used a trial only re-trials when renewable.
    const signupTrialConfig = normalizeFreeTrialConfig(club.freeTrialConfig);
    let trialNote: string | null = null;
    let trialGrantedTo: string | null = null;
    if (data.requestTrial) {
      const want = trialTargetFor(plan);
      if (!signupTrialConfig?.active) {
        trialNote = "This club doesn't have a free trial running right now.";
      } else if (want.target === "none") {
        trialNote = want.reason;
      } else {
        const athlete =
          want.target === "child"
            ? createdChild
              ? await prisma.member.findUnique({
                  where: { id: createdChild.id },
                  select: { id: true, firstName: true, trialEndsAt: true, userId: true },
                })
              : null
            : user.memberProfile
              ? { ...user.memberProfile, firstName: user.memberProfile.firstName }
              : null;

        if (!athlete) {
          trialNote = "We couldn't find an athlete to start the trial on. The club can add it for you.";
        } else {
          // Shape-A guard: never stamp an entitlement onto a record that is
          // simultaneously the athlete and the athlete's own guardian. Whose
          // trial would it be? That record is ambiguous until it is split.
          const guardianLinks = await prisma.memberGuardianUser.findMany({
            where: { memberId: athlete.id },
            select: { userId: true },
          });
          if (
            trialBlockedBySelfGuardian({
              userId: athlete.userId,
              guardianUserIds: guardianLinks.map((g) => g.userId),
            })
          ) {
            trialNote =
              "We couldn't start the trial automatically on this profile — please ask the club to set it up.";
            console.error("Refused trial on a self-guardian member (shape A):", athlete.id);
          } else {
            const days = trialWindowDays(club.freeTrialConfig, athlete);
            const hasActiveSub = await prisma.memberSubscription.findFirst({
              where: { memberId: athlete.id, status: "active" },
              select: { id: true },
            });
            if (days && !hasActiveSub) {
              await prisma.member.update({
                where: { id: athlete.id },
                data: { trialEndsAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000) },
              });
              trialGrantedTo = athlete.firstName;
            } else {
              trialNote = hasActiveSub
                ? "That athlete already has an active membership, so there's no trial to start."
                : "This trial has already been used on that athlete.";
            }
          }
        }
      }
    }

    // Signup documents attach to the ATHLETE the signup created — the child on
    // the guardian path (where the guardian is the signer of record), the
    // account holder otherwise. A guardian-only signup creates no athlete, so
    // there is nothing to attach them to.
    const docMember = createdChild
      ? { id: createdChild.id, isMinor: true }
      : user.memberProfile
        ? { id: user.memberProfile.id, isMinor: user.memberProfile.isMinor }
        : null;
    if (signupDocs.length > 0 && docMember) {
      const signed = new Set(data.signedDocumentIds);
      const ipAddress = ipFromRequest(req);
      const signedAt = new Date();
      for (const doc of signupDocs.filter((d) => signed.has(d.id))) {
        // On the guardian path the guardian signs everything for the child, not
        // just the docs flagged as guardian-required — they are the only adult
        // in the transaction and the child has no login to sign with.
        const signerIsGuardian = !!createdChild || (docMember.isMinor && doc.requiresGuardianSignature);
        const signerName = createdChild
          ? `${data.firstName} ${data.lastName}`.trim()
          : signerIsGuardian
            ? data.guardianName || `${data.firstName} ${data.lastName}`.trim()
            : `${data.firstName} ${data.lastName}`.trim();
        await prisma.documentSignature.upsert({
          where: { documentId_memberId: { documentId: doc.id, memberId: docMember.id } },
          update: {
            signerUserId: user.id,
            signerName,
            relationship: signerIsGuardian ? "GUARDIAN" : "SELF",
            ipAddress,
            userAgent: req.headers.get("user-agent"),
            signedAt,
          },
          create: {
            documentId: doc.id,
            memberId: docMember.id,
            signerUserId: user.id,
            signerName,
            relationship: signerIsGuardian ? "GUARDIAN" : "SELF",
            ipAddress,
            userAgent: req.headers.get("user-agent"),
            signedAt,
          },
        });
      }
    }

    return NextResponse.json(
      {
        ok: true,
        clubSlug: club.slug,
        guardianLinkPending,
        pendingGuardianConsent,
        // What the account holder should be told next. `intent` lets the client
        // route a guardian to "add your athlete" instead of an empty portal,
        // and `sweptChildren` is the "we found 2 children already listed under
        // your email" line.
        intent: plan.kind,
        athlete: createdChild ? { firstName: createdChild.firstName } : null,
        sweptChildren,
        trialGrantedTo,
        trialNote,
      },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors }, { status: 400 });
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
