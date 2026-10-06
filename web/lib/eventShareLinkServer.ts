// Server half of the private share link: minting tokens and turning a
// /e/<segment> address into the event it means. The rules live in
// lib/eventShareLink (pure, tested); this file is the only reader of the
// event_share_links table besides /api/events/[id]/share-link.

import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { parseLinkSegment, tokenFromBytes, type LinkVia } from "@/lib/eventShareLink";

export function generateShareToken(): string {
  for (;;) {
    const token = tokenFromBytes(randomBytes(48));
    if (token) return token;
  }
}

/** What a registration remembers about the link it came in by. Not reversible. */
export function shareTokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

export type ResolvedEventLink = {
  /** The token the address carried — only when it matched a link. */
  token?: string;
  /** Pass to prisma.event.findUnique — by id for a token, by slug otherwise. */
  where: { id: string } | { publicSlug: string };
  via: LinkVia;
};

/**
 * One lookup for the page API, the register route, the discount check and the
 * price quote, so a private link behaves exactly like the public one.
 *
 * A plain slug costs nothing extra. Only an address shaped like `s-<token>` is
 * looked up in event_share_links first; when no link has that token it falls
 * back to the slug, because an older public slug can have the same shape.
 */
export async function resolveEventLink(segment: string): Promise<ResolvedEventLink> {
  const parsed = parseLinkSegment(segment);
  if (parsed.kind === "token") {
    const link = await prisma.eventShareLink
      .findUnique({ where: { token: parsed.token }, select: { eventId: true } })
      .catch((err) => {
        // Reads only. If the table isn't there yet (migration not applied) a
        // public slug of this shape must still open.
        console.error("[share-link] token lookup failed", err);
        return null;
      });
    if (link) return { where: { id: link.eventId }, via: "token", token: parsed.token };
  }
  return { where: { publicSlug: parsed.slug }, via: "slug" };
}

/** The event's current token, or null. Never throws — a link is optional. */
export async function shareTokenForEvent(eventId: string): Promise<string | null> {
  const link = await prisma.eventShareLink
    .findUnique({ where: { eventId }, select: { token: true } })
    .catch(() => null);
  return link?.token ?? null;
}
