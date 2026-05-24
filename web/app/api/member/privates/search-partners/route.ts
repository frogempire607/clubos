import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { findOrAutoLinkMember } from "@/lib/memberLink";

// GET /api/member/privates/search-partners?q=... — light-weight member typeahead
// scoped to the member's club, used by the partner picker. Excludes the
// requesting member from the results. Limit 20.
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const clubId = session.user.clubId;
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { email: true },
  });
  const self = user ? await findOrAutoLinkMember(session.user.id, clubId, user.email) : null;

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") || "").trim();
  if (q.length < 2) return NextResponse.json([]);

  const tokens = q.split(/\s+/).filter(Boolean);
  const results = await prisma.member.findMany({
    where: {
      clubId,
      deletedAt: null,
      ...(self ? { NOT: { id: self.id } } : {}),
      AND: tokens.map((t) => ({
        OR: [
          { firstName: { contains: t, mode: "insensitive" } },
          { lastName: { contains: t, mode: "insensitive" } },
          { email: { contains: t, mode: "insensitive" } },
        ],
      })),
    },
    select: { id: true, firstName: true, lastName: true, email: true },
    take: 20,
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
  });

  return NextResponse.json(results);
}
