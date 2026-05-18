import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireOwner } from "@/lib/apiGuard";

// Branded mobile-app configuration. Owner-only — this drives the native
// wrapper (Capacitor) the club ships to the App Store / Google Play.

type BrandedAppConfig = {
  appName: string;
  shortDescription: string;
  iconUrl: string | null;
  themeColor: string;
  splashColor: string;
  iosBundleId: string;
  androidPackage: string;
  enabled: boolean;
};

function slugToReverseDomain(slug: string) {
  const clean = slug.replace(/[^a-z0-9]/gi, "").toLowerCase() || "club";
  return `com.athletixos.${clean}`;
}

function defaults(club: { name: string; slug: string; primaryColor: string | null; logoUrl: string | null }): BrandedAppConfig {
  return {
    appName: club.name,
    shortDescription: `${club.name} member portal — schedule, bookings, documents, and messages.`,
    iconUrl: club.logoUrl,
    themeColor: club.primaryColor || "#1C1917",
    splashColor: "#FFFFFF",
    iosBundleId: slugToReverseDomain(club.slug),
    androidPackage: slugToReverseDomain(club.slug),
    enabled: false,
  };
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requireOwner(session);
  if (denied) return denied;

  const club = await prisma.club.findUnique({
    where: { id: session.user.clubId },
    select: {
      name: true,
      slug: true,
      primaryColor: true,
      logoUrl: true,
      tier: true,
      brandedAppConfig: true,
    },
  });
  if (!club) return NextResponse.json({ error: "Club not found" }, { status: 404 });

  const saved = (club.brandedAppConfig as Partial<BrandedAppConfig> | null) || {};
  const config: BrandedAppConfig = { ...defaults(club), ...saved };

  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3001";
  return NextResponse.json({
    config,
    club: { name: club.name, slug: club.slug, tier: club.tier },
    portalUrl: `${baseUrl}/member`,
    loginUrl: `${baseUrl}/login?club=${club.slug}&role=member`,
  });
}

const schema = z.object({
  appName: z.string().min(1).max(30),
  shortDescription: z.string().max(200).optional().default(""),
  iconUrl: z.string().nullable().optional(),
  themeColor: z
    .string()
    .regex(/^#([0-9a-fA-F]{6})$/, "Use a 6-digit hex color like #1C1917"),
  splashColor: z
    .string()
    .regex(/^#([0-9a-fA-F]{6})$/, "Use a 6-digit hex color like #FFFFFF"),
  iosBundleId: z
    .string()
    .regex(/^[a-zA-Z0-9.-]+$/, "Bundle ID can only contain letters, numbers, dots and hyphens"),
  androidPackage: z
    .string()
    .regex(/^[a-zA-Z0-9._]+$/, "Package name can only contain letters, numbers, dots and underscores"),
  enabled: z.boolean().optional().default(false),
});

export async function PATCH(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requireOwner(session);
  if (denied) return denied;

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors[0]?.message || "Invalid input" }, { status: 400 });
    }
    throw err;
  }

  const config: BrandedAppConfig = {
    appName: body.appName.trim(),
    shortDescription: body.shortDescription?.trim() || "",
    iconUrl: body.iconUrl || null,
    themeColor: body.themeColor,
    splashColor: body.splashColor,
    iosBundleId: body.iosBundleId,
    androidPackage: body.androidPackage,
    enabled: !!body.enabled,
  };

  await prisma.club.update({
    where: { id: session.user.clubId },
    data: { brandedAppConfig: config },
  });

  return NextResponse.json({ ok: true, config });
}
