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
      },
    });

    return NextResponse.json({ id: club.id, slug: club.slug });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors }, { status: 400 });
    }
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }
}
