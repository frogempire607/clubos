import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasPermission, type PermissionKey, type PermissionLevel } from "@/lib/permissions";

// GET /api/search?q=
// Universal, club-scoped, permission-filtered search across the dashboard.
// Returns small grouped result sets with deep links. Fast: capped + indexed
// columns, parallel queries, only the categories the user may view.
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const q = (new URL(req.url).searchParams.get("q") || "").trim();
  if (q.length < 2) return NextResponse.json({ groups: [] });

  const clubId = session.user.clubId;
  const role = (session.user as any).role as string;
  const perms = (session.user as any).permissions as Record<string, unknown> | null;
  const can = (key: PermissionKey, level: PermissionLevel = "view") =>
    role === "OWNER" || hasPermission(perms, key, level);

  const like = { contains: q, mode: "insensitive" as const };
  const TAKE = 6;

  const [members, staff, classes, events, products, memberships, documents, messages] =
    await Promise.all([
      can("members")
        ? prisma.member.findMany({
            where: {
              clubId,
              deletedAt: null,
              OR: [{ firstName: like }, { lastName: like }, { email: like }, { phone: like }],
            },
            select: { id: true, firstName: true, lastName: true, email: true, status: true },
            take: TAKE,
            orderBy: { updatedAt: "desc" },
          })
        : [],
      can("staff")
        ? prisma.user.findMany({
            where: {
              clubId,
              deletedAt: null,
              role: { in: ["OWNER", "STAFF"] },
              OR: [{ firstName: like }, { lastName: like }, { email: like }],
            },
            select: { id: true, firstName: true, lastName: true, email: true, role: true },
            take: TAKE,
          })
        : [],
      can("classes")
        ? prisma.recurringClass.findMany({
            where: { clubId, deletedAt: null, name: like },
            select: { id: true, name: true, active: true },
            take: TAKE,
          })
        : [],
      can("events")
        ? prisma.event.findMany({
            where: { clubId, deletedAt: null, name: like },
            select: { id: true, name: true, startsAt: true },
            take: TAKE,
            orderBy: { startsAt: "desc" },
          })
        : [],
      can("events")
        ? prisma.product.findMany({
            where: { clubId, deletedAt: null, name: like },
            select: { id: true, name: true, price: true },
            take: TAKE,
          })
        : [],
      can("events")
        ? prisma.membership.findMany({
            where: { clubId, deletedAt: null, name: like },
            select: { id: true, name: true },
            take: TAKE,
          })
        : [],
      can("documents")
        ? prisma.document.findMany({
            where: { clubId, deletedAt: null, title: like },
            select: { id: true, title: true, type: true },
            take: TAKE,
          })
        : [],
      can("messages")
        ? prisma.message.findMany({
            where: { clubId, body: like },
            select: { id: true, body: true, createdAt: true },
            take: TAKE,
            orderBy: { createdAt: "desc" },
          })
        : [],
    ]);

  type Hit = { id: string; label: string; sub?: string; href: string };
  const groups: { type: string; label: string; items: Hit[] }[] = [];
  const add = (type: string, label: string, items: Hit[]) => {
    if (items.length) groups.push({ type, label, items });
  };

  add(
    "members",
    "Members",
    members.map((m) => ({
      id: m.id,
      label: `${m.firstName} ${m.lastName}`.trim(),
      sub: m.email ?? m.status,
      href: `/dashboard/members/${m.id}`,
    })),
  );
  add(
    "staff",
    "Staff",
    staff.map((s) => ({
      id: s.id,
      label: `${s.firstName} ${s.lastName}`.trim(),
      sub: s.role === "OWNER" ? "Owner" : (s.email ?? "Staff"),
      href: "/dashboard/staff",
    })),
  );
  add(
    "classes",
    "Classes",
    classes.map((c) => ({
      id: c.id,
      label: c.name,
      sub: c.active ? "Active" : "Inactive",
      href: "/dashboard/classes",
    })),
  );
  add(
    "events",
    "Events",
    events.map((e) => ({
      id: e.id,
      label: e.name,
      sub: new Date(e.startsAt).toLocaleDateString(),
      href: "/dashboard/events",
    })),
  );
  add(
    "products",
    "Products",
    products.map((p) => ({
      id: p.id,
      label: p.name,
      sub: `$${Number(p.price).toFixed(2)}`,
      href: "/dashboard/products",
    })),
  );
  add(
    "memberships",
    "Memberships",
    memberships.map((m) => ({
      id: m.id,
      label: m.name,
      href: "/dashboard/memberships",
    })),
  );
  add(
    "documents",
    "Documents",
    documents.map((d) => ({
      id: d.id,
      label: d.title,
      sub: d.type,
      href: "/dashboard/documents",
    })),
  );
  add(
    "messages",
    "Messages",
    messages.map((m) => ({
      id: m.id,
      label: m.body.slice(0, 60) + (m.body.length > 60 ? "…" : ""),
      sub: new Date(m.createdAt).toLocaleDateString(),
      href: "/dashboard/messages",
    })),
  );

  return NextResponse.json({ groups });
}
