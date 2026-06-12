// Signed unsubscribe links for announcement/broadcast emails (CAN-SPAM).
//
// The link carries an HMAC of clubId+email keyed on NEXTAUTH_SECRET, so it
// needs no login and no DB token storage, and a recipient can't forge an
// opt-out for someone else's address without the secret.

import { createHmac, timingSafeEqual } from "crypto";
import { getAppBaseUrl } from "@/lib/baseUrl";

function secret(): string {
  const s = process.env.NEXTAUTH_SECRET;
  if (!s) throw new Error("NEXTAUTH_SECRET is not set");
  return s;
}

export function unsubscribeToken(clubId: string, email: string): string {
  return createHmac("sha256", secret())
    .update(`unsub:${clubId}:${email.trim().toLowerCase()}`)
    .digest("hex")
    .slice(0, 32);
}

export function verifyUnsubscribeToken(clubId: string, email: string, token: string): boolean {
  const expected = unsubscribeToken(clubId, email);
  if (token.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

export function buildUnsubscribeUrl(clubId: string, email: string): string {
  const e = email.trim().toLowerCase();
  const qs = new URLSearchParams({ c: clubId, e, t: unsubscribeToken(clubId, e) });
  return `${getAppBaseUrl()}/api/unsubscribe?${qs.toString()}`;
}
