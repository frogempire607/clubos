import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sanitizeRichHtml } from "@/lib/sanitizeHtml";
import { REQUIRED_DOCUMENT_SURFACES } from "@/lib/documents";

const updateSchema = z.object({
  title: z.string().min(1).optional(),
  type: z.enum(["Waiver", "Policy", "Agreement", "Handbook", "Other"]).optional(),
  body: z.string().nullable().optional(),
  required: z.boolean().optional(),
  requiredAt: z.array(z.enum(REQUIRED_DOCUMENT_SURFACES)).optional(),
  requiresGuardianSignature: z.boolean().optional(),
  deliveryTrigger: z.enum(["MANUAL", "MEMBERSHIP", "EVENT", "MESSAGE"]).optional(),
  expiresAt: z.string().nullable().optional(),
  publishAt: z.string().nullable().optional(),
  unpublishAt: z.string().nullable().optional(),
  signatureValidForDays: z.number().int().positive().nullable().optional(),
  // Event attachment (lib/eventDocuments.ts): All-Events auto-applies to
  // future events; eventRequirement is what attachment means (INFO |
  // ACKNOWLEDGE | SIGN_REQUIRED).
  appliesToAllEvents: z.boolean().optional(),
  eventRequirement: z.enum(["INFO", "ACKNOWLEDGE", "SIGN_REQUIRED"]).optional(),
});

async function getDoc(id: string, clubId: string) {
  return prisma.document.findFirst({
    where: { id, clubId, deletedAt: null },
  });
}

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const doc = await getDoc(params.id, session.user.clubId);
  if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(doc);
}

export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const doc = await getDoc(params.id, session.user.clubId);
  if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const data = updateSchema.parse(await req.json());
    const updated = await prisma.document.update({
      where: { id: params.id },
      data: {
        ...(data.title !== undefined && { title: data.title }),
        ...(data.type !== undefined && { type: data.type }),
        // Sanitized on write — see app/api/documents/route.ts POST for
        // the same treatment on create.
        ...(data.body !== undefined && {
          body: data.body ? sanitizeRichHtml(data.body) : null,
        }),
        // `requiredAt` drives `required`; if only the legacy flag is sent, honor it.
        ...(data.requiredAt !== undefined
          ? (() => {
              const requiredAt = Array.from(new Set(data.requiredAt));
              return { requiredAt, required: requiredAt.length > 0 };
            })()
          : data.required !== undefined
            ? { required: data.required }
            : {}),
        ...(data.requiresGuardianSignature !== undefined && { requiresGuardianSignature: data.requiresGuardianSignature }),
        ...(data.deliveryTrigger !== undefined && { deliveryTrigger: data.deliveryTrigger }),
        ...(data.expiresAt !== undefined && { expiresAt: data.expiresAt ? new Date(data.expiresAt) : null }),
        ...(data.publishAt !== undefined && {
          publishAt: data.publishAt ? new Date(data.publishAt) : null,
        }),
        ...(data.unpublishAt !== undefined && {
          unpublishAt: data.unpublishAt ? new Date(data.unpublishAt) : null,
        }),
        ...(data.signatureValidForDays !== undefined && { signatureValidForDays: data.signatureValidForDays }),
      },
    });
    return NextResponse.json(updated);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors }, { status: 400 });
    }
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}

export async function DELETE(
  _req: Request,
  context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const doc = await getDoc(params.id, session.user.clubId);
  if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.document.update({
    where: { id: params.id },
    data: { deletedAt: new Date() },
  });

  return NextResponse.json({ ok: true });
}
