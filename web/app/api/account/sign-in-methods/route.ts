import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { rateLimit, rateLimitedResponse } from "@/lib/ratelimit";
import { canRemoveMethod, passwordIsUsable, providerLabel } from "@/lib/socialAuth";
import { availableProviders, revokeAppleToken } from "@/lib/socialAuthServer";

// GET    /api/account/sign-in-methods            the caller's own ways in
// DELETE /api/account/sign-in-methods?id=<row>   remove one (never the last)
//
// Acts only on the signed-in person's own rows.

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const [user, identities] = await Promise.all([
    prisma.user.findUnique({ where: { id: session.user.id }, select: { passwordHash: true, email: true, club: { select: { slug: true } } } }),
    prisma.userIdentity.findMany({
      where: { userId: session.user.id, clubId: session.user.clubId },
      orderBy: { createdAt: "asc" },
      select: { id: true, provider: true, email: true, emailIsRelay: true, createdAt: true, lastUsedAt: true },
    }),
  ]);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const hasPassword = passwordIsUsable(user.passwordHash);
  const removable = canRemoveMethod({ hasPassword, identityCount: identities.length });
  const linked = new Set(identities.map((i) => i.provider));
  return NextResponse.json(
    {
      hasPassword,
      accountEmail: user.email,
      clubSlug: user.club.slug,
      methods: identities.map((i) => ({
        id: i.id,
        provider: i.provider,
        label: providerLabel(i.provider as "GOOGLE" | "APPLE"),
        email: i.emailIsRelay ? null : i.email,
        hiddenEmail: i.emailIsRelay,
        createdAt: i.createdAt,
        lastUsedAt: i.lastUsedAt,
        removable,
      })),
      // What can still be connected: configured, and not connected yet.
      connectable: availableProviders().filter((p) => !linked.has(p === "google" ? "GOOGLE" : "APPLE")),
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function DELETE(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const rl = rateLimit({ key: `sign-in-methods:${session.user.id}`, limit: 10, windowMs: 60_000 });
  if (!rl.allowed) return rateLimitedResponse(rl);

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Which method?" }, { status: 400 });
  const [user, identities] = await Promise.all([
    prisma.user.findUnique({ where: { id: session.user.id }, select: { passwordHash: true } }),
    prisma.userIdentity.findMany({ where: { userId: session.user.id, clubId: session.user.clubId }, select: { id: true, provider: true, refreshTokenEnc: true } }),
  ]);
  const target = identities.find((i) => i.id === id);
  if (!user || !target) return NextResponse.json({ error: "That sign-in method isn't on your account." }, { status: 404 });
  if (!canRemoveMethod({ hasPassword: passwordIsUsable(user.passwordHash), identityCount: identities.length })) {
    return NextResponse.json(
      { error: "This is your only way to sign in. Add a password or another method first.", code: "LAST_METHOD" },
      { status: 409 },
    );
  }
  // Conditional on still having another way in: two tabs removing the two
  // remaining methods at once must not leave the account with none.
  const removed = await prisma.$transaction(async (tx) => {
    const count = await tx.userIdentity.count({ where: { userId: session.user.id } });
    if (!passwordIsUsable(user.passwordHash) && count < 2) return false;
    await tx.userIdentity.delete({ where: { id: target.id } });
    return true;
  });
  if (!removed) return NextResponse.json({ error: "This is your only way to sign in.", code: "LAST_METHOD" }, { status: 409 });
  if (target.provider === "APPLE") await revokeAppleToken(target.refreshTokenEnc);
  return NextResponse.json({ ok: true });
}
