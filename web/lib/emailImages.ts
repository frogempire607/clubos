// Signed public image URLs for email bodies.
//
// Every `<img>` inside an email must be reachable without a session — the
// recipient's inbox is not logged in. `/api/files/[id]` is session-gated
// and 401s in Gmail, so the composer rewrites `image` block src to the
// signed URL produced here.
//
// Signature: HMAC-SHA256(EMAIL_IMAGE_SECRET, `img:<fileId>`), truncated to
// 32 hex characters. No expiry — historical emails must render years after
// they were sent, so the token stays valid forever. That's why the secret
// is separate from NEXTAUTH_SECRET (rotating auth must not break images in
// already-sent email).
//
// If EMAIL_IMAGE_SECRET is unset, buildEmailImageUrl() throws — a caller
// who tried to embed an image without a configured secret would have
// produced a dead URL, and we'd rather surface the config error at compose
// time than ship broken email.

import { createHmac, timingSafeEqual } from "crypto";
import { getAppBaseUrl } from "@/lib/baseUrl";

function secret(): string {
  const s = process.env.EMAIL_IMAGE_SECRET;
  if (!s) {
    throw new Error(
      "EMAIL_IMAGE_SECRET is not set. Set it before embedding images in email; " +
        "it must be independent of NEXTAUTH_SECRET so rotating auth doesn't break " +
        "images in already-sent messages.",
    );
  }
  return s;
}

export function isEmailImageSigningConfigured(): boolean {
  return Boolean(process.env.EMAIL_IMAGE_SECRET);
}

export function signEmailImageId(fileId: string): string {
  return createHmac("sha256", secret())
    .update(`img:${fileId}`)
    .digest("hex")
    .slice(0, 32);
}

export function verifyEmailImageToken(fileId: string, token: string): boolean {
  const expected = signEmailImageId(fileId);
  if (typeof token !== "string" || token.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  } catch {
    return false;
  }
}

export function buildEmailImageUrl(fileId: string): string {
  const token = signEmailImageId(fileId);
  return `${getAppBaseUrl()}/api/public/images/${encodeURIComponent(fileId)}?t=${token}`;
}
