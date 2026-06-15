import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sanitizeRichHtml } from "@/lib/sanitizeHtml";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const docs = await prisma.document.findMany({
    where: { clubId: session.user.clubId, deletedAt: null },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(docs);
}

const createSchema = z.object({
  title: z.string().min(1),
  type: z.enum(["Waiver", "Policy", "Agreement", "Handbook", "Other"]),
  body: z.string().nullable().optional(),
  required: z.boolean().default(false),
  requiresGuardianSignature: z.boolean().default(false),
  deliveryTrigger: z.enum(["MANUAL", "MEMBERSHIP", "EVENT", "MESSAGE"]).default("MANUAL"),
  expiresAt: z.string().nullable().optional(),
  signatureValidForDays: z.number().int().positive().nullable().optional(),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const data = createSchema.parse(await req.json());
    const doc = await prisma.document.create({
      data: {
        clubId: session.user.clubId,
        title: data.title,
        type: data.type,
        // Sanitized on write — rendered via dangerouslySetInnerHTML on
        // both /dashboard/documents (owner) and /member/documents (member).
        body: data.body ? sanitizeRichHtml(data.body) : null,
        required: data.required,
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
