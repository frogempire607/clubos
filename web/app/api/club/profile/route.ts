import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const profile = await prisma.clubProfile.findUnique({
    where: { clubId: session.user.clubId },
  });

  // Return defaults if no profile row yet
  return NextResponse.json(
    profile ?? {
      termForMember: "Member",
      termForCoach: "Coach",
      termForClass: "Class",
      termForEvent: "Event",
      termForMembership: "Membership",
      welcomeMessage: null,
      accentColor: null,
      portalSections: ["schedule", "documents", "profile"],
    }
  );
}

const schema = z.object({
  termForMember:     z.string().min(1).max(32).optional(),
  termForCoach:      z.string().min(1).max(32).optional(),
  termForClass:      z.string().min(1).max(32).optional(),
  termForEvent:      z.string().min(1).max(32).optional(),
  termForMembership: z.string().min(1).max(32).optional(),
  welcomeMessage:    z.string().max(500).optional().nullable(),
  accentColor:       z.string().max(7).optional().nullable(),
  portalSections:    z.array(z.string()).optional(),
});

export async function PATCH(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = schema.parse(await req.json());

    const profile = await prisma.clubProfile.upsert({
      where: { clubId: session.user.clubId },
      create: { clubId: session.user.clubId, ...body },
      update: body,
    });

    return NextResponse.json(profile);
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors }, { status: 400 });
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
