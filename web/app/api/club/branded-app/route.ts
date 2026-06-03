import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireOwner } from "@/lib/apiGuard";
import { getAppBaseUrl } from "@/lib/baseUrl";
import {
  defaultBrandedAppConfig,
  mergeBrandedAppConfig,
  type BrandedAppConfig,
} from "@/lib/brandedApp";

// Branded mobile-app configuration. Owner-only — this drives the native
// wrapper (Capacitor) the club ships to the App Store / Google Play.

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

  const config = mergeBrandedAppConfig(defaultBrandedAppConfig(club), club.brandedAppConfig);

  const baseUrl = getAppBaseUrl();
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
}).passthrough();

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

  const club = await prisma.club.findUnique({
    where: { id: session.user.clubId },
    select: { name: true, slug: true, primaryColor: true, logoUrl: true, brandedAppConfig: true },
  });
  if (!club) return NextResponse.json({ error: "Club not found" }, { status: 404 });

  const config: BrandedAppConfig = mergeBrandedAppConfig(
    defaultBrandedAppConfig(club),
    {
      ...(body as unknown as Record<string, unknown>),
      appName: body.appName.trim(),
      shortDescription: body.shortDescription?.trim() || "",
      iconUrl: body.iconUrl || null,
      themeColor: body.themeColor,
      splashColor: body.splashColor,
      iosBundleId: body.iosBundleId,
      androidPackage: body.androidPackage,
      enabled: !!body.enabled,
    },
  );

  await prisma.club.update({
    where: { id: session.user.clubId },
    data: { brandedAppConfig: config },
  });

  return NextResponse.json({ ok: true, config });
}
