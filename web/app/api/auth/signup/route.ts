import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { rateLimit, rateLimitedResponse, ipFromRequest } from "@/lib/ratelimit";

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  mode: z.enum(["create", "join"]),
  clubSlug: z.string().optional(),
  // Consent — must be EXACTLY true. z.literal(true) rejects undefined/false/"true"
  // and gives a clean 400 instead of silently storing no consent record.
  acceptedTerms: z.literal(true),
  termsVersion: z.string().min(1),
  privacyVersion: z.string().min(1),
});

export async function POST(req: Request) {
  // 5 signups per 10 minutes per IP. New club creation is rare so this
  // is generous enough for a real demo / signup-night spike without
  // letting a script create hundreds of clubs.
  const rl = rateLimit({ key: `auth:signup:${ipFromRequest(req)}`, limit: 5, windowMs: 10 * 60_000 });
  if (!rl.allowed) return rateLimitedResponse(rl, "Too many signup attempts. Try again in a few minutes.");

  try {
    const body = await req.json();
    const data = schema.parse(body);

    let clubId: string;
    let clubSlug: string;
    let role: "OWNER" | "MEMBER";

    if (data.mode === "create") {
      const tempSlug = `club-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const club = await prisma.club.create({
        data: { name: "My Club", slug: tempSlug },
      });
      clubId = club.id;
      clubSlug = club.slug;
      role = "OWNER";
    } else {
      if (!data.clubSlug) {
        return NextResponse.json({ error: "Club code required" }, { status: 400 });
      }
      const club = await prisma.club.findUnique({ where: { slug: data.clubSlug } });
      if (!club) {
        return NextResponse.json({ error: "Club not found" }, { status: 404 });
      }
      clubId = club.id;
      clubSlug = club.slug;
      role = "MEMBER";
    }

    const existing = await prisma.user.findUnique({
      where: { clubId_email: { clubId, email: data.email.toLowerCase() } },
    });
    if (existing) {
      return NextResponse.json({ error: "Email already registered" }, { status: 409 });
    }

    const passwordHash = await bcrypt.hash(data.password, 12);
    const user = await prisma.user.create({
      data: {
        clubId,
        email: data.email.toLowerCase(),
        passwordHash,
        firstName: data.firstName,
        lastName: data.lastName,
        role,
      },
    });

    // Record terms/privacy consent. Wrapped in try/catch + feature-detection
    // so this route keeps working before the LegalAcceptance migration is
    // applied (Task 8 — see docs/proposed-migration-legal-acceptance.md).
    // Once `prisma.legalAcceptance` exists, real rows are written; until
    // then the route logs a structured warning so the gap is visible in
    // server logs without blocking signup.
    try {
      const acceptedAt = new Date();
      const ipAddress = ipFromRequest(req);
      const userAgent = req.headers.get("user-agent") || null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any;
      if (typeof p.legalAcceptance?.createMany === "function") {
        await p.legalAcceptance.createMany({
          data: [
            { userId: user.id, clubId, documentType: "TOS",     version: data.termsVersion,   acceptedAt, ipAddress, userAgent },
            { userId: user.id, clubId, documentType: "PRIVACY", version: data.privacyVersion, acceptedAt, ipAddress, userAgent },
          ],
        });
      } else {
        console.warn(
          `[legal-acceptance:pending-migration] userId=${user.id} clubId=${clubId} ` +
          `termsVersion=${data.termsVersion} privacyVersion=${data.privacyVersion} ` +
          `acceptedAt=${acceptedAt.toISOString()} ipAddress=${ipAddress} userAgent=${userAgent}`
        );
      }
    } catch (err) {
      // Never block signup on the consent record — log + continue.
      console.error("Failed to persist legal acceptance:", err);
    }

    return NextResponse.json({ id: user.id, email: user.email, clubSlug }, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors }, { status: 400 });
    }
    return NextResponse.json({ error: "Signup failed" }, { status: 500 });
  }
}
