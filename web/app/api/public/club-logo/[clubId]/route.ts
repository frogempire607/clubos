import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getObject } from "@/lib/storage";

// PUBLIC, UNAUTHENTICATED — streams ONLY a club's own logo image.
//
// Why this exists: club logos appear in emails (activation/onboarding) and on
// public pages (the activation page seen by logged-out members). The normal
// file route, /api/files/[id], is session-gated by design, so those contexts
// got a broken image. A club logo is not sensitive, so we expose it here — but
// narrowly: we resolve the logo strictly from the club's own `logoUrl` and only
// serve a stored file that belongs to that same club. Arbitrary file IDs can't
// be read through this route.
export async function GET(_req: Request, context: { params: Promise<{ clubId: string }> }) {
  const { clubId } = await context.params;

  const club = await prisma.club.findUnique({
    where: { id: clubId },
    select: { logoUrl: true },
  });
  if (!club?.logoUrl) {
    return NextResponse.json({ error: "No logo" }, { status: 404 });
  }

  // External absolute logo → just redirect to it.
  if (/^https?:\/\//i.test(club.logoUrl)) {
    return NextResponse.redirect(club.logoUrl);
  }

  // Otherwise expect our own /api/files/<fileId> path.
  const match = club.logoUrl.match(/\/api\/files\/([^/?#]+)/);
  if (!match) {
    return NextResponse.json({ error: "No logo" }, { status: 404 });
  }
  const fileId = match[1];

  const file = await prisma.uploadedFile.findUnique({
    where: { id: fileId },
    select: { clubId: true, storageKey: true, mimeType: true },
  });
  // Only ever serve a file that is this club's own logo.
  if (!file || file.clubId !== clubId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const bytes = await getObject(file.storageKey);
  if (!bytes) {
    return NextResponse.json({ error: "File missing in storage" }, { status: 404 });
  }

  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": file.mimeType,
      "Content-Length": String(bytes.length),
      // Public and cacheable — a club logo is not sensitive.
      "Cache-Control": "public, max-age=3600",
    },
  });
}
