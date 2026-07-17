import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sanitizeRichHtml } from "@/lib/sanitizeHtml";
import { REQUIRED_DOCUMENT_SURFACES } from "@/lib/documents";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const docs = await prisma.document.findMany({
    where: { clubId: session.user.clubId, deletedAt: null },
    orderBy: { createdAt: "desc" },
    // Which events each document is attached to (for the "linked events"
    // display; All-Events docs list none here — the flag says it all).
    include: {
      eventLinks: {
        select: { eventId: true, event: { select: { id: true, name: true, startsAt: true } } },
      },
    },
  });

  return NextResponse.json(docs);
}

const createSchema = z.object({
  title: z.string().min(1),
  type: z.enum(["Waiver", "Policy", "Agreement", "Handbook", "Other"]),
  body: z.string().nullable().optional(),
  required: z.boolean().default(false),
  // Where a signature is mandatory. When omitted, falls back to the legacy
  // `required` flag (treated as ONBOARDING) so older callers still work.
  requiredAt: z.array(z.enum(REQUIRED_DOCUMENT_SURFACES)).optional(),
  requiresGuardianSignature: z.boolean().default(false),
  deliveryTrigger: z.enum(["MANUAL", "MEMBERSHIP", "EVENT", "MESSAGE"]).default("MANUAL"),
  expiresAt: z.string().nullable().optional(),
  signatureValidForDays: z.number().int().positive().nullable().optional(),
  appliesToAllEvents: z.boolean().default(false),
  eventRequirement: z.enum(["INFO", "ACKNOWLEDGE", "SIGN_REQUIRED"]).default("INFO"),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const data = createSchema.parse(await req.json());
    // `requiredAt` is the source of truth; `required` is mirrored from it so
    // legacy reads (member portal, activation) keep working. A bare
    // required:true with no surfaces is treated as onboarding.
    const requiredAt =
      data.requiredAt && data.requiredAt.length > 0
        ? Array.from(new Set(data.requiredAt))
        : data.required
          ? ["ONBOARDING"]
          : [];
    const doc = await prisma.document.create({
      data: {
        clubId: session.user.clubId,
        title: data.title,
        type: data.type,
        // Sanitized on write — rendered via dangerouslySetInnerHTML on
        // both /dashboard/documents (owner) and /member/documents (member).
        body: data.body ? sanitizeRichHtml(data.body) : null,
        required: requiredAt.length > 0,
        requiredAt,
        requiresGuardianSignature: data.requiresGuardianSignature,
        deliveryTrigger: data.deliveryTrigger,
        expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
        signatureValidForDays: data.signatureValidForDays ?? null,
      },
    });
    return NextResponse.json(doc, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors }, { status: 400 });
    }
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
