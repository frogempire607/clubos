// Product photos and event covers on pages people see WITHOUT a staff login.
//
// Uploads are stored behind `/api/files/<id>`, which only streams to a
// logged-in user of the same club — right for documents, wrong for a shirt
// photo on the public product page (/p/…) or an event cover on /e/…: a
// logged-out buyer got a broken "?" image. These helpers rewrite such paths to
// `/api/public/media/<kind>/<ownerId>/<fileId>`, which serves a file ONLY when
// the named product/event actually uses it (see that route). External
// absolute URLs pass through untouched.

export type MediaKind = "product" | "event";

/** The upload id inside our own `/api/files/<id>` path, else null. */
export function uploadedFileId(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/\/api\/files\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

export function publicMediaUrl(kind: MediaKind, ownerId: string, url: string | null | undefined): string | null {
  if (!url) return null;
  const id = uploadedFileId(url);
  if (!id) return url;
  return `/api/public/media/${kind}/${encodeURIComponent(ownerId)}/${encodeURIComponent(id)}`;
}

/** Every photo URL a product's settings/imageUrl reference (cover, gallery, variants). */
export function productPhotoUrls(row: { imageUrl: string | null; settings: unknown }): string[] {
  const s = (row.settings && typeof row.settings === "object" ? row.settings : {}) as Record<string, unknown>;
  const out: string[] = [];
  if (row.imageUrl) out.push(row.imageUrl);
  if (Array.isArray(s.photos)) for (const p of s.photos) if (typeof p === "string") out.push(p);
  if (Array.isArray(s.variants)) {
    for (const v of s.variants as Record<string, unknown>[]) if (v && typeof v.photoUrl === "string") out.push(v.photoUrl);
  }
  return out;
}
