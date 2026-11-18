import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import { providerLabel, readToken, type PendingPayload } from "@/lib/socialAuth";
import { PENDING_COOKIE, clearCookie } from "@/lib/socialAuthHttp";

// GET    /api/auth/social/pending — what the "which account?" page shows
// DELETE /api/auth/social/pending — "never mind": forget the Google/Apple answer
//
// It never says whether an account exists for the address: the page offers
// the same two choices either way.
export async function GET() {
  const p = readToken<PendingPayload>("pending", cookies().get(PENDING_COOKIE)?.value, new Date(), process.env.NEXTAUTH_SECRET);
  if (!p) return NextResponse.json({ pending: null });
  const club = await prisma.club.findUnique({ where: { id: p.clubId }, select: { name: true, slug: true } });
  return NextResponse.json(
    {
      pending: {
        provider: p.provider,
        providerLabel: providerLabel(p.provider),
        // Their own address, shown back to them; never the relay address,
        // which they did not choose and would not recognise.
        email: p.emailIsRelay ? null : p.email,
        hiddenEmail: p.emailIsRelay,
        firstName: p.firstName,
        lastName: p.lastName,
        clubSlug: club?.slug ?? p.clubSlug,
        clubName: club?.name ?? null,
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function DELETE() {
  return clearCookie(NextResponse.json({ ok: true }), PENDING_COOKIE, "/");
}
