import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { readFile } from "fs/promises";
import { join } from "path";

function storageRoot(): string {
  return process.env.UPLOADS_DIR || join(process.cwd(), "storage", "uploads");
}

// GET /api/files/[id]
// Streams a stored file ONLY if the requester is a logged-in user in the same
// club as the file. Replaces the previous /public/uploads scheme where any URL
// guesser could read every uploaded file.
export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const file = await prisma.uploadedFile.findUnique({
    where: { id: params.id },
    select: { clubId: true, storageKey: true, mimeType: true, originalName: true },
  });
  if (!file) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (file.clubId !== session.user.clubId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(join(storageRoot(), file.storageKey));
  } catch {
    return NextResponse.json({ error: "File missing on disk" }, { status: 410 });
  }

  // Use a buffer copy so the underlying ArrayBuffer is a plain ArrayBuffer (not SharedArrayBuffer).
  const body = new Uint8Array(bytes);
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": file.mimeType,
      "Content-Length": String(bytes.length),
      "Cache-Control": "private, max-age=3600",
      "Content-Disposition": `inline; filename="${file.originalName.replace(/"/g, "")}"`,
    },
  });
}
