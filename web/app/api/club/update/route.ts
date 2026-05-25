import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const schema = z.object({
  name: z.string().min(1),
  slug: z.string().min(2).regex(/^[a-z0-9-]+$/, "Lowercase letters, numbers, and dashes only"),
  sport: z.string().optional(),
  tagline: z.string().optional(),
  primaryColor: z.string().optional(),
  logoUrl: z.string().optional().nullable(),
  aboutUs: z.string().max(5000).optional().nullable(),
  coverImageUrl: z.string().optional().nullable(),
  contactEmail: z.string().optional().nullable(),
  contactPhone: z.string().optional().nullable(),
  websiteUrl: z.string().optional().nullable(),
  socialLinks: z.array(z.object({ label: z.string(), url: z.string() })).optional(),
  hoursOfOperation: z.record(z.string()).optional().nullable(),
  // Branded app personalization
  appFontFamily: z.string().max(200).optional().nullable(),
  appTextAlign: z.enum(["left", "center", "right"]).optional().nullable(),
  appHomeContent: z.string().max(5000).optional().nullable(),
  appCopy: z.record(z.string()).optional().nullable(),
  builtInEventColors: z.record(
    z.object({ bg: z.string(), fg: z.string() }),
  ).optional().nullable(),
});

export async function PATCH(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session || session.user.role !== "OWNER") {
      return NextResponse.json({ error: "Not authorized" }, { status: 401 });
    }

    const body = await req.json();
    const data = schema.parse(body);

    // Check if new slug conflicts with another club
    const existing = await prisma.club.findUnique({ where: { slug: data.slug } });
    if (existing && existing.id !== session.user.clubId) {
      return NextResponse.json({ error: "Slug already taken" }, { status: 409 });
    }

    const club = await prisma.club.update({
      where: { id: session.user.clubId },
      data: {
        name: data.name,
        slug: data.slug,
        sport: data.sport || null,
        tagline: data.tagline || null,
        primaryColor: data.primaryColor || "#534AB7",
        ...(data.logoUrl !== undefined ? { logoUrl: data.logoUrl || null } : {}),
        ...(data.aboutUs !== undefined ? { aboutUs: data.aboutUs || null } : {}),
        ...(data.coverImageUrl !== undefined ? { coverImageUrl: data.coverImageUrl || null } : {}),
        ...(data.contactEmail !== undefined ? { contactEmail: data.contactEmail || null } : {}),
        ...(data.contactPhone !== undefined ? { contactPhone: data.contactPhone || null } : {}),
        ...(data.websiteUrl !== undefined ? { websiteUrl: data.websiteUrl || null } : {}),
        ...(data.socialLinks !== undefined ? { socialLinks: data.socialLinks } : {}),
        ...(data.hoursOfOperation !== undefined ? { hoursOfOperation: data.hoursOfOperation ?? undefined } : {}),
        ...(data.appFontFamily !== undefined ? { appFontFamily: data.appFontFamily || null } : {}),
        ...(data.appTextAlign !== undefined ? { appTextAlign: data.appTextAlign || null } : {}),
        ...(data.appHomeContent !== undefined ? { appHomeContent: data.appHomeContent || null } : {}),
        ...(data.appCopy !== undefined ? { appCopy: data.appCopy ?? undefined } : {}),
        ...(data.builtInEventColors !== undefined ? { builtInEventColors: data.builtInEventColors ?? undefined } : {}),
      },
    });

    return NextResponse.json({ id: club.id, slug: club.slug });
  } catch (err) {
    if (err instanceof z.ZodError) {
      // Return a readable message — not the raw Zod issue array, which the
      // client used to stringify as "[object Object],[object Object]".
      const first = err.errors[0];
      const path = first?.path?.join(".") || "field";
      const message = first?.message || "Invalid input";
      return NextResponse.json(
        {
          error: `${path}: ${message}`,
          issues: err.errors.map((e) => ({
            path: e.path.join("."),
            message: e.message,
          })),
        },
        { status: 400 },
      );
    }
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }
}
