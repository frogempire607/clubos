import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getObject } from "@/lib/storage";
import { verifyEmailImageToken } from "@/lib/emailImages";

// GET /api/public/images/[fileId]?t=<hmac>
//
// Streams an existing UploadedFile — unauthenticated, but only if the
// caller presents a valid HMAC token for this exact fileId. Used for
// <img> tags in email bodies (where /api/files/[id] would 401 because the
// recipient's inbox is not logged in).
//
// The token is a truncated HMAC-SHA256 of `img:<fileId>` keyed on
// EMAIL_IMAGE_SECRET. NO expiry — historical emails must render years
// later, so we deliberately don't bake a timestamp into the token. The
// secret is separate from NEXTAUTH_SECRET so rotating auth doesn't break
// images in already-sent email.
//
// Only IMAGE-kind UploadedFile rows are served. Documents (PDF etc.) stay
// behind the session-gated /api/files/[id] route — an anonymous, cached
// document link is a data-leak vector we don't want.
//
// Cache: public + immutable for a year. The fileId is unguessable and
// the underlying storage key never changes, so intermediary CDNs may
// cache aggressively.

export const dynamic = "force-dynamic";

export async function GET(req: Request, context: { params: Promise<{ fileId: string }> }) {
  const { fileId } = await context.params;
  const url = new URL(req.url);
  const token = url.searchParams.get("t") ?? "";

  if (!token || !verifyEmailImageToken(fileId, token)) {
    return NextResponse.json({ error: "Invalid or missing signature" }, { status: 403 });
  }

  const file = await prisma.uploadedFile.findUnique({
    where: { id: fileId },
    select: {
      storageKey: true,
      mimeType: true,
      originalName: true,
      kind: true,
    },
  });
  if (!file) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (file.kind !== "IMAGE") {
    return NextResponse.json({ error: "Not an image" }, { status: 403 });
  }

  const bytes = await getObject(file.storageKey);
  if (!bytes) {
    return NextResponse.json({ error: "File missing in storage" }, { status: 410 });
  }

  const body = new Uint8Array(bytes);
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": file.mimeType,
      "Content-Length": String(bytes.length),
      // Long, immutable — the URL is content-addressable (fileId + signature).
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Disposition": `inline; filename="${file.originalName.replace(/"/g, "")}"`,
    },
  });
}
