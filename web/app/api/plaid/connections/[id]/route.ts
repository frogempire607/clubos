import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// PATCH /api/plaid/connections/[id] — rename the bank connection. The
// label is the friendly name owners use to tell their accounts apart
// (e.g. "Operating", "Foundation", "Savings").
const patchSchema = z.object({ label: z.string().max(80).nullable() });

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const conn = await prisma.plaidConnection.findFirst({
    where: { id: params.id, clubId: session.user.clubId, deletedAt: null },
  });
  if (!conn) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const { label } = patchSchema.parse(await req.json());
    const updated = await prisma.plaidConnection.update({
      where: { id: conn.id },
      data: { label: label?.trim() || null },
    });
    return NextResponse.json({ id: updated.id, label: updated.label });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors[0]?.message ?? "Invalid input" }, { status: 400 });
    }
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }
}

// DELETE /api/plaid/connections/[id] — soft-delete the connection. We
// don't revoke the Plaid access token automatically so the owner can
// reconnect with the same institution later if needed.
export async function DELETE(_req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const conn = await prisma.plaidConnection.findFirst({
    where: { id: params.id, clubId: session.user.clubId, deletedAt: null },
  });
  if (!conn) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.plaidConnection.update({
    where: { id: conn.id },
    data: { deletedAt: new Date() },
  });

  // If the legacy Club fields still point at this connection, clear them
  // so the older single-account UI doesn't keep showing a stale name.
  const club = await prisma.club.findUnique({
    where: { id: session.user.clubId },
    select: { plaidItemId: true },
  });
  if (club?.plaidItemId === conn.itemId) {
    const replacement = await prisma.plaidConnection.findFirst({
      where: { clubId: session.user.clubId, deletedAt: null },
      orderBy: { createdAt: "asc" },
    });
    await prisma.club.update({
      where: { id: session.user.clubId },
      data: {
        plaidAccessToken: replacement?.accessToken ?? null,
        plaidItemId: replacement?.itemId ?? null,
      },
    });
  }

  return NextResponse.json({ ok: true });
}
