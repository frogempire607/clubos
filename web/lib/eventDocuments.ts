// Reusable event documents — attach EXISTING club documents to events.
// One system: the same Document/DocumentSignature machinery that runs
// onboarding/signup signing (guardian rules, drawn signatures, expiry,
// audit trail) is what events reuse. This file only adds the event scoping
// and the enforcement lookups.
//
// Scoping: Document.appliesToAllEvents covers every event (including future
// ones) until unset; EventDocumentLink rows scope a document to one/selected
// events. Requirement level lives on the Document (Document.eventRequirement):
//   INFO          — shown on the event, nothing required
//   ACKNOWLEDGE   — registrant must tick acknowledgement to register
//   SIGN_REQUIRED — a valid signature is required before registration AND
//                   check-in (minors: guardian signs, per the existing rules)

import { prisma } from "@/lib/prisma";

export const EVENT_DOC_REQUIREMENTS = ["INFO", "ACKNOWLEDGE", "SIGN_REQUIRED"] as const;
export type EventDocRequirement = (typeof EVENT_DOC_REQUIREMENTS)[number];

export const EVENT_DOC_REQUIREMENT_LABELS: Record<EventDocRequirement, string> = {
  INFO: "Informational",
  ACKNOWLEDGE: "Must acknowledge",
  SIGN_REQUIRED: "Must sign before registering / check-in",
};

export type EventDoc = {
  id: string;
  title: string;
  type: string;
  body: string | null;
  requirement: EventDocRequirement;
  appliesToAllEvents: boolean;
  requiresGuardianSignature: boolean;
  signatureValidForDays: number | null;
};

function normalizeRequirement(v: unknown): EventDocRequirement {
  return (EVENT_DOC_REQUIREMENTS as readonly string[]).includes(v as string)
    ? (v as EventDocRequirement)
    : "INFO";
}

/** Live documents attached to an event (specific links + All Events docs). */
export async function documentsForEvent(clubId: string, eventId: string): Promise<EventDoc[]> {
  const now = new Date();
  const docs = await prisma.document.findMany({
    where: {
      clubId,
      deletedAt: null,
      AND: [
        { OR: [{ publishAt: null }, { publishAt: { lte: now } }] },
        { OR: [{ unpublishAt: null }, { unpublishAt: { gt: now } }] },
        { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      ],
      OR: [{ appliesToAllEvents: true }, { eventLinks: { some: { eventId } } }],
    },
    select: {
      id: true,
      title: true,
      type: true,
      body: true,
      eventRequirement: true,
      appliesToAllEvents: true,
      requiresGuardianSignature: true,
      signatureValidForDays: true,
    },
    orderBy: { title: "asc" },
  });
  return docs.map((d) => ({
    id: d.id,
    title: d.title,
    type: d.type,
    body: d.body,
    requirement: normalizeRequirement(d.eventRequirement),
    appliesToAllEvents: d.appliesToAllEvents,
    requiresGuardianSignature: d.requiresGuardianSignature,
    signatureValidForDays: d.signatureValidForDays,
  }));
}

/**
 * A member's valid (non-expired) signature check — the SAME expiry rule the
 * member documents page uses: signedAt + signatureValidForDays.
 */
function signatureIsValid(
  sig: { signedAt: Date } | null | undefined,
  validForDays: number | null,
  now: Date,
): boolean {
  if (!sig) return false;
  if (!validForDays) return true;
  const expires = new Date(sig.signedAt);
  expires.setDate(expires.getDate() + validForDays);
  return expires > now;
}

/**
 * SIGN_REQUIRED documents this member hasn't validly signed yet — the
 * registration/check-in blocker. Fails SAFE for the member: any lookup error
 * is thrown to the caller (routes decide), never silently treated as signed.
 */
export async function missingSignedEventDocs(
  clubId: string,
  eventId: string,
  memberId: string,
): Promise<Array<{ id: string; title: string }>> {
  const docs = (await documentsForEvent(clubId, eventId)).filter(
    (d) => d.requirement === "SIGN_REQUIRED",
  );
  if (docs.length === 0) return [];
  const now = new Date();
  const sigs = await prisma.documentSignature.findMany({
    where: { memberId, documentId: { in: docs.map((d) => d.id) } },
    orderBy: { signedAt: "desc" },
    select: { documentId: true, signedAt: true },
  });
  const latest = new Map<string, { signedAt: Date }>();
  for (const s of sigs) if (!latest.has(s.documentId)) latest.set(s.documentId, s);
  return docs
    .filter((d) => !signatureIsValid(latest.get(d.id), d.signatureValidForDays, now))
    .map((d) => ({ id: d.id, title: d.title }));
}

/** ACKNOWLEDGE-or-stricter docs a registrant must tick before registering. */
export async function acknowledgementDocs(
  clubId: string,
  eventId: string,
): Promise<Array<{ id: string; title: string }>> {
  return (await documentsForEvent(clubId, eventId))
    .filter((d) => d.requirement === "ACKNOWLEDGE")
    .map((d) => ({ id: d.id, title: d.title }));
}
