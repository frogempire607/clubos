// Upload storage backend.
//
// Production (Netlify): Supabase Storage — private "uploads" bucket, accessed
// server-side with the service role key. Netlify's filesystem is ephemeral, so
// local disk MUST NOT be used there.
//
// Local dev fallback: when SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not
// set, falls back to ./storage/uploads on disk (same behavior as before).
//
// Security model is unchanged: the bucket is private, objects are only ever
// read/written through these helpers, and /api/files/[id] remains the single
// club-scoped gate for serving bytes.

import { writeFile, mkdir, readFile } from "fs/promises";
import { join } from "path";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || "uploads";

export function isRemoteStorage(): boolean {
  return Boolean(SUPABASE_URL && SERVICE_KEY);
}

function diskRoot(): string {
  return process.env.UPLOADS_DIR || join(process.cwd(), "storage", "uploads");
}

function objectUrl(key: string): string {
  return `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${encodeURIComponent(key)}`;
}

/** Store a file. Throws on failure so callers return a 500 instead of a dead URL. */
export async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  if (isRemoteStorage()) {
    const res = await fetch(objectUrl(key), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": contentType,
        "x-upsert": "false",
      },
      body: new Uint8Array(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Storage upload failed (${res.status}): ${detail.slice(0, 200)}`);
    }
    return;
  }
  const root = diskRoot();
  await mkdir(root, { recursive: true });
  await writeFile(join(root, key), body);
}

/** Fetch a file's bytes. Returns null when the object is missing. */
export async function getObject(key: string): Promise<Buffer | null> {
  if (isRemoteStorage()) {
    const res = await fetch(objectUrl(key), {
      headers: { Authorization: `Bearer ${SERVICE_KEY}` },
    });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  }
  try {
    return await readFile(join(diskRoot(), key));
  } catch {
    return null;
  }
}
