// GET  /api/email-templates                → list (lazy-seeds 14 stock templates on first call per club)
// POST /api/email-templates                → create a new CUSTOM template (owner-authored blank)
//
// Templates are per-club. isSystem rows are protected from hard delete
// (they can be archived and duplicated). Duplicating a system row lands
// as CUSTOM kind so the owner's edits don't drift from the reference.

import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission, requireMessagesSubScope } from "@/lib/apiGuard";
import { validateEmailBlocks } from "@/lib/emailBlocks";
import { renderEmail } from "@/lib/emailRender";
import { STOCK_TEMPLATES } from "@/lib/emailTemplates";
import { resolvePostalAddressLines } from "@/lib/emailPostalAddress";

const createSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional().nullable(),
  subject: z.string().max(300).default(""),
  previewText: z.string().max(200).optional().nullable(),
  blocks: z.array(z.unknown()).min(1),
  kind: z.string().max(64).optional(), // defaults to CUSTOM
});

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "messages", "view");
  if (denied) return denied;

  const clubId = session.user.clubId;

  // Lazy seed: if no system templates exist for this club, insert the 14
  // stock ones now. We check by kind + isSystem to avoid double-seeding
  // when an owner has cloned some. createMany with skipDuplicates would
  // be simpler but there's no (clubId, kind) unique constraint (owners
  // may have multiple GENERAL_ANNOUNCEMENT rows after duplication), so
  // we check the "was this club ever seeded" question via any existing
  // system row.
  const anySystem = await prisma.emailTemplate.findFirst({
    where: { clubId, isSystem: true },
    select: { id: true },
  });
  if (!anySystem) {
    await seedStockTemplates(clubId, session.user.id);
  }

  const templates = await prisma.emailTemplate.findMany({
    where: { clubId },
    orderBy: [{ archivedAt: "asc" }, { isSystem: "desc" }, { name: "asc" }],
    select: {
      id: true,
      kind: true,
      name: true,
      description: true,
      subject: true,
      previewText: true,
      bodyJson: true,
      isSystem: true,
      archivedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return NextResponse.json({ templates });
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "messages", "edit");
  if (denied) return denied;
  const scopeDenied = requireMessagesSubScope(session, "templates");
  if (scopeDenied) return scopeDenied;

  let data: z.infer<typeof createSchema>;
  try {
    data = createSchema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  const blocksResult = validateEmailBlocks(data.blocks);
  if (!blocksResult.ok) {
    return NextResponse.json({ error: "Invalid blocks", details: blocksResult.errors }, { status: 400 });
  }

  const rendered = await renderEmailForSnapshot(session.user.clubId, blocksResult.blocks, data.subject);

  const t = await prisma.emailTemplate.create({
    data: {
      clubId: session.user.clubId,
      kind: data.kind ?? "CUSTOM",
      name: data.name,
      description: data.description ?? null,
      subject: data.subject,
      previewText: data.previewText ?? null,
      bodyJson: blocksResult.blocks as unknown as object,
      bodyHtml: rendered.html,
      bodyText: rendered.text,
      isSystem: false,
      createdById: session.user.id,
      updatedById: session.user.id,
    },
    select: { id: true, kind: true, name: true },
  });

  return NextResponse.json(t, { status: 201 });
}

// ── Seed helpers ──────────────────────────────────────────────────────────

async function seedStockTemplates(clubId: string, actorUserId: string) {
  // Fetch minimum club info needed to render the seed bodyHtml snapshot.
  // Snapshot HTML is a convenience — bodyJson is canonical and is what
  // gets re-rendered per send anyway, so a stale bodyHtml doesn't hurt.
  const club = await prisma.club.findUnique({
    where: { id: clubId },
    select: {
      id: true, name: true, primaryColor: true,
      contactEmail: true, contactPhone: true, publicEmail: true, publicPhone: true, websiteUrl: true,
      mailingAddress: true, mailingAddress2: true, mailingCity: true,
      mailingState: true, mailingZip: true, mailingCountry: true,
      logoUrl: true,
    },
  });
  if (!club) return;

  const rows = await Promise.all(STOCK_TEMPLATES.map(async (t) => {
    const rendered = await renderEmail(t.blocks, {
      clubName: club.name,
      clubLogoUrl: null, // snapshot uses default; actual send resolves publicClubLogoUrl
      clubContact: {
        email: club.publicEmail ?? club.contactEmail,
        phone: club.publicPhone ?? club.contactPhone,
        website: club.websiteUrl,
        address: null,
      },
      club,
      postalAddress: resolvePostalAddressLines(club),
      accentColor: club.primaryColor,
    });
    return {
      clubId,
      kind: t.kind,
      name: t.name,
      description: t.description,
      subject: t.subject,
      previewText: t.previewText || null,
      bodyJson: t.blocks as unknown as object,
      bodyHtml: rendered.html,
      bodyText: rendered.text,
      isSystem: true,
      createdById: actorUserId,
      updatedById: actorUserId,
    };
  }));

  // Bulk insert. If a race puts two seeders side-by-side, the second one
  // will duplicate the 14 rows — cheap and idempotent from the owner's
  // POV (they can archive dupes). We could add an advisory lock but the
  // window is tiny (the isSystem check right above) and duplication is
  // not a correctness bug, just cosmetic.
  await prisma.emailTemplate.createMany({ data: rows });
}

async function renderEmailForSnapshot(clubId: string, blocks: unknown[], subject: string) {
  const club = await prisma.club.findUnique({
    where: { id: clubId },
    select: {
      id: true, name: true, primaryColor: true,
      contactEmail: true, contactPhone: true, publicEmail: true, publicPhone: true, websiteUrl: true,
      mailingAddress: true, mailingAddress2: true, mailingCity: true,
      mailingState: true, mailingZip: true, mailingCountry: true,
    },
  });
  if (!club) return { html: "", text: subject };
  const rendered = await renderEmail(blocks as never, {
    clubName: club.name,
    clubLogoUrl: null,
    clubContact: {
      email: club.publicEmail ?? club.contactEmail,
      phone: club.publicPhone ?? club.contactPhone,
      website: club.websiteUrl,
      address: null,
    },
    club,
    postalAddress: resolvePostalAddressLines(club),
    accentColor: club.primaryColor,
  });
  return rendered;
}
