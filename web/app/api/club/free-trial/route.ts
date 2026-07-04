import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { Prisma } from "@prisma/client";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { normalizeFreeTrialConfig } from "@/lib/freeTrial";
import { getAppBaseUrl } from "@/lib/baseUrl";

// The club's single Free Trial offer (Club.freeTrialConfig). Managed from the
// Memberships page. Saving through this route migrates the club off the
// legacy per-membership trial flags: the config becomes the only source of
// truth (legacy columns are zeroed so a later DELETE can't resurrect them).

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "events", "view");
  if (denied) return denied;

  const club = await prisma.club.findUnique({
    where: { id: session.user.clubId },
    select: { slug: true, freeTrialConfig: true },
  });
  if (!club) return NextResponse.json({ error: "Club not found" }, { status: 404 });

  const config = normalizeFreeTrialConfig(club.freeTrialConfig);
  // Legacy view: which memberships still carry their own trial flags — shown
  // in the editor before first save so the owner sees what will consolidate.
  const legacyTrialMemberships = config
    ? []
    : await prisma.membership.findMany({
        where: { clubId: session.user.clubId, deletedAt: null, trialEnabled: true },
        select: { id: true, name: true, trialDays: true, trialAppliesToReturning: true },
      });

  return NextResponse.json({
    config,
    legacyTrialMemberships,
    signupUrl: `${getAppBaseUrl()}/member/signup?club=${encodeURIComponent(club.slug)}&trial=1`,
  });
}

const putSchema = z.object({
  name: z.string().trim().min(1).max(80),
  days: z.number().int().min(1).max(365),
  membershipIds: z.array(z.string()).max(200).default([]),
  renewable: z.boolean().default(true),
  allowRepeatUse: z.boolean().default(false),
  active: z.boolean().default(true),
});

export async function PUT(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "events", "edit");
  if (denied) return denied;

  let data: z.infer<typeof putSchema>;
  try {
    data = putSchema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    throw err;
  }

  // Only keep ids that are real memberships of this club.
  const valid = data.membershipIds.length
    ? await prisma.membership.findMany({
        where: { id: { in: data.membershipIds }, clubId: session.user.clubId, deletedAt: null },
        select: { id: true },
      })
    : [];
  const membershipIds = valid.map((m) => m.id);

  const config = {
    name: data.name,
    days: data.days,
    membershipIds,
    renewable: data.renewable,
    allowRepeatUse: data.allowRepeatUse,
    active: data.active,
  };

  await prisma.$transaction([
    prisma.club.update({
      where: { id: session.user.clubId },
      data: { freeTrialConfig: config as Prisma.InputJsonValue },
    }),
    // Consolidate: the central offer is now the only trial source of truth.
    prisma.membership.updateMany({
      where: { clubId: session.user.clubId },
      data: { trialEnabled: false, trialDays: null },
    }),
  ]);

  return NextResponse.json({ ok: true, config });
}

// DELETE = the club offers no free trial at all (explicit, not "unset" —
// unset would fall back to the legacy flags). Legacy flags were already
// zeroed by the first PUT; zero them again defensively.
export async function DELETE() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "events", "full");
  if (denied) return denied;

  const config = {
    name: "Free trial",
    days: 7,
    membershipIds: [],
    renewable: true,
    allowRepeatUse: false,
    active: false,
  };
  await prisma.$transaction([
    prisma.club.update({
      where: { id: session.user.clubId },
      data: { freeTrialConfig: config as Prisma.InputJsonValue },
    }),
    prisma.membership.updateMany({
      where: { clubId: session.user.clubId },
      data: { trialEnabled: false, trialDays: null },
    }),
  ]);
  return NextResponse.json({ ok: true });
}
