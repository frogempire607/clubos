import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { randomBytes } from "crypto";
import { rateLimit, rateLimitedResponse } from "@/lib/ratelimit";

const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml",
]);
const ALLOWED_DOC_TYPES = new Set([
  ...ALLOWED_IMAGE_TYPES,
  "application/pdf", "text/plain",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const MAX_SIZE = 10 * 1024 * 1024; // 10 MB

// Storage root. Defaults to ./storage/uploads (NOT under /public so files are
// not served as static assets — they go through /api/files/[id] which enforces
// club scoping).
function storageRoot(): string {
  return process.env.UPLOADS_DIR || join(process.cwd(), "storage", "uploads");
}

// FormData can't be validated by zod directly, but we can still validate
// the unpacked primitives after the parse.
const uploadFieldsSchema = z.object({
  type: z.enum(["image", "document"]).default("image"),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Rate limit: 30 uploads per minute per user. File uploads are the
  // most disk-expensive endpoint we expose; this stops a runaway client
  // from filling /storage/uploads with junk.
  const rl = rateLimit({
    key: `upload:${session.user.id}`,
    limit: 30,
    windowMs: 60_000,
  });
  if (!rl.allowed) return rateLimitedResponse(rl, "Too many uploads. Wait a moment and try again.");

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  const fieldsParsed = uploadFieldsSchema.safeParse({
    type: formData.get("type") || undefined,
  });
  if (!fieldsParsed.success) {
    return NextResponse.json(
      { error: fieldsParsed.error.errors[0]?.message || "Invalid upload fields." },
      { status: 400 }
    );
  }
  const { type } = fieldsParsed.data;

  const file = formData.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "No file provided" }, { status: 400 });
  if (file.size <= 0) return NextResponse.json({ error: "Empty file" }, { status: 400 });
  if (file.size > MAX_SIZE) return NextResponse.json({ error: "File too large (max 10 MB)" }, { status: 400 });

  const allowed = type === "document" ? ALLOWED_DOC_TYPES : ALLOWED_IMAGE_TYPES;
  if (!allowed.has(file.type)) {
    return NextResponse.json({ error: `File type ${file.type} not allowed` }, { status: 400 });
  }

  const bytes = await file.arrayBuffer();
  const buffer = Buffer.from(bytes);

  const root = storageRoot();
  await mkdir(root, { recursive: true });

  const rawExt = file.name.split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") || "bin";
  // Unguessable random storage key. Different from the row id so even leaked
  // ids can't be used to construct a disk path.
  const storageKey = `${randomBytes(16).toString("hex")}.${rawExt}`;
  await writeFile(join(root, storageKey), buffer);

  const kind = type === "document" && !ALLOWED_IMAGE_TYPES.has(file.type) ? "DOCUMENT" : "IMAGE";
  const record = await prisma.uploadedFile.create({
    data: {
      clubId: session.user.clubId,
      uploaderId: session.user.id,
      storageKey,
      originalName: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      kind,
    },
  });

  return NextResponse.json({
    id: record.id,
    // /api/files/[id] is the only way to fetch the bytes; it scopes by clubId.
    url: `/api/files/${record.id}`,
  });
}
