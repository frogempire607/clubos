import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { rateLimit, rateLimitedResponse, ipFromRequest } from "@/lib/ratelimit";
import { requestGuardianLink } from "@/lib/guardianLink";
import { missingRequiredDocumentIds, requiredDocumentSurfaceWhere } from "@/lib/documents";
import { normalizeFreeTrialConfig, trialWindowDays } from "@/lib/freeTrial";
import { createGuardianConsentRequest, recordParentalConsent } from "@/lib/parentalConsent";
import { sendGuardianConsentRequestEmail } from "@/lib/email";
import { getAppBaseUrl } from "@/lib/baseUrl";

const schema = z.object({
  clubSlug: z.string().min(1),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
  accountType: z.enum(["ADULT_ATHLETE", "MINOR_ATHLETE", "PARENT"]),
  dateOfBirth: z.string().optional(),
  // Guardian info (for MINOR_ATHLETE)
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

    // Check for existing user account in this club
    const existing = await prisma.user.findUnique({
      where: { clubId_email: { clubId: club.id, email: data.email.toLowerCase() } },
    });
    if (existing && !existing.deletedAt) {
      return NextResponse.json({ error: "An account with this email already exists. Try logging in." }, { status: 409 });
    }

    const passwordHash = await bcrypt.hash(data.password, 12);
    const isMinor = data.accountType === "MINOR_ATHLETE";

    // COPPA: a minor cannot self-activate. We need a guardian email to send the
    // consent link, and the account stays gated (login/actions blocked) until a
    // guardian completes consent.
    if (isMinor && !(data.guardianEmail || "").trim()) {
      return NextResponse.json(
        { error: "A parent or guardian email is required to sign up a minor. Their consent is needed before the account can be used." },
        { status: 400 },
      );
    }

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
              : {
                  memberProfile: {
                    create: {
                      clubId: club.id,
                      firstName: data.firstName,
                      lastName: data.lastName,
                      email: data.email.toLowerCase(),
                      status: "ACTIVE",
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
              : {
                  memberProfile: {
                    create: {
                      clubId: club.id,
                      firstName: data.firstName,
                      lastName: data.lastName,
                      email: data.email.toLowerCase(),
                      status: "ACTIVE",
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

    // Public free-trial link: grant the class-trial window to the athlete
    // profile this signup created. Requires an explicitly ACTIVE Free Trial
    // offer — a hand-crafted ?trial=1 URL on a club that never configured
    // one grants nothing. A resurrected profile that already used a trial
    // only re-trials when the offer is renewable. PARENT signups create no
    // athlete, so nothing to grant.
    const signupTrialConfig = normalizeFreeTrialConfig(club.freeTrialConfig);
    if (data.requestTrial && signupTrialConfig?.active && user.memberProfile) {
      const days = trialWindowDays(club.freeTrialConfig, user.memberProfile);
      const hasActiveSub = await prisma.memberSubscription.findFirst({
        where: { memberId: user.memberProfile.id, status: "active" },
        select: { id: true },
      });
      if (days && !hasActiveSub) {
        await prisma.member.update({
          where: { id: user.memberProfile.id },
          data: { trialEndsAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000) },
        });
      }
    }

    if (signupDocs.length > 0 && user.memberProfile) {
      const signed = new Set(data.signedDocumentIds);
      const ipAddress = ipFromRequest(req);
      const signedAt = new Date();
      for (const doc of signupDocs.filter((d) => signed.has(d.id))) {
        const signerIsGuardian = user.memberProfile.isMinor && doc.requiresGuardianSignature;
        const signerName = signerIsGuardian
          ? data.guardianName || `${data.firstName} ${data.lastName}`.trim()
          : `${data.firstName} ${data.lastName}`.trim();
        await prisma.documentSignature.upsert({
          where: { documentId_memberId: { documentId: doc.id, memberId: user.memberProfile.id } },
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
            memberId: user.memberProfile.id,
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

    return NextResponse.json({ ok: true, clubSlug: club.slug, guardianLinkPending, pendingGuardianConsent }, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors }, { status: 400 });
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
