import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getObject } from "@/lib/storage";
import { productPhotoUrls, uploadedFileId } from "@/lib/publicMedia";

// PUBLIC, UNAUTHENTICATED — streams a product photo or an event cover image.
//
// /api/files/[id] is session-gated, so a logged-out buyer on /p/… or /e/… saw
// a broken image. This route is deliberately narrow: it serves a file only if
// (1) it is an IMAGE upload, (2) the named product/event belongs to the same
// club as the file, is not deleted, and (3) that product/event actually uses
// this file as a photo. Any other file id — a waiver, a document — 404s.
export async function GET(_req: Request, context: { params: Promise<{ kind: string; ownerId: string; fileId: string }> }) {
  const { kind, ownerId, fileId } = await context.params;
  const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });

  let ownerClubId: string | null = null;
  if (kind === "product") {
    const p = await prisma.product.findUnique({ where: { id: ownerId }, select: { clubId: true, deletedAt: true, imageUrl: true, settings: true } });
    if (!p || p.deletedAt) return notFound();
    if (!productPhotoUrls(p).some((u) => uploadedFileId(u) === fileId)) return notFound();
    ownerClubId = p.clubId;
  } else if (kind === "event") {
    const e = await prisma.event.findUnique({ where: { id: ownerId }, select: { clubId: true, deletedAt: true, imageUrl: true } });
    if (!e || e.deletedAt || uploadedFileId(e.imageUrl) !== fileId) return notFound();
    ownerClubId = e.clubId;
  } else {
    return notFound();
  }

  const file = await prisma.uploadedFile.findUnique({ where: { id: fileId }, select: { clubId: true, storageKey: true, mimeType: true, kind: true } });
  if (!file || file.clubId !== ownerClubId || file.kind !== "IMAGE" || !file.mimeType.startsWith("image/")) return notFound();

  const bytes = await getObject(file.storageKey);
  if (!bytes) return notFound();
  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": file.mimeType,
      "Content-Length": String(bytes.length),
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      // An uploaded SVG must never run script in our origin.
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
  });
}
