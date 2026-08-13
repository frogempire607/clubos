// Server-side loader for the confirmation surface (§5.2.3).
//
// Shared by the two routes that render it — /e/[slug]/registered/[id] and the
// /r/[id] fallback for events with no public slug — and by the calendar file,
// so all three read one row through one resolver. A registration is public by
// URL on purpose: the person who registered may have no account, and the
// unguessable cuid IS the credential. Nothing sensitive beyond what the
// confirmation email already told them is exposed.

import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { getAppBaseUrl, baseUrlFromRequest } from "@/lib/baseUrl";
import { resolveCardSnapshot, prettyBrand } from "@/lib/memberCard";
import { resolveEventPolicy } from "@/lib/eventPayments";
import { confirmationCodeFor } from "@/lib/confirmationCode";
import {
  renderableRegistrationState,
  type RegistrationRenderContext,
} from "@/lib/registrationRenderState";

/**
 * The origin the visitor is actually on. Server components have no Request, so
 * this rebuilds one from the incoming headers and reuses the same host-trust
 * rules — a Netlify preview must link to itself rather than bouncing the
 * visitor to production, and an untrusted Host header must not end up in a
 * link (§5.2.3).
 */
function baseUrlFromHeaders(): string {
  try {
    const h = headers();
    return baseUrlFromRequest(new Request("https://placeholder.invalid", { headers: h }));
  } catch {
    return getAppBaseUrl();
  }
}

export type LoadedRegistration = {
  ctx: RegistrationRenderContext;
  timeZone: string | null;
  eventName: string;
  startsAt: Date;
  endsAt: Date;
  locationName: string | null;
  confirmationCode: string;
};

export async function loadRegistrationPage(registrationId: string): Promise<LoadedRegistration | null> {
  const reg = await prisma.eventRegistration.findUnique({
    where: { id: registrationId },
    include: {
      event: { include: { customEventType: { select: { defaultPolicy: true } }, location: true } },
      club: {
        select: { id: true, name: true, contactEmail: true, contactPhone: true, timezone: true, stripeAccountId: true },
      },
      member: {
        select: { id: true, stripeCustomerId: true, stripeSetupCustomerId: true },
      },
    },
  });
  if (!reg || reg.event.deletedAt) return null;

  // Backfill on first read (§5.2.3): every row that reaches a human has a
  // number by the time they read it, without a migration that would have had
  // to duplicate the derivation in SQL.
  let code = reg.confirmationCode;
  if (!code) {
    code = confirmationCodeFor(reg.id);
    await prisma.eventRegistration
      .updateMany({ where: { id: reg.id, confirmationCode: null }, data: { confirmationCode: code } })
      .catch(() => undefined);
  }

  const activeCount = await prisma.eventRegistration.count({
    where: { eventId: reg.eventId, status: { not: "CANCELED" } },
  });

  let cardLabel: string | null = null;
  const customerId = reg.member?.stripeSetupCustomerId ?? reg.member?.stripeCustomerId ?? null;
  if (customerId && reg.club.stripeAccountId) {
    try {
      const card = await resolveCardSnapshot(customerId, reg.club.stripeAccountId);
      if (card) cardLabel = `${prettyBrand(card.brand)} ····${card.last4}${card.cardholder ? ` (${card.cardholder})` : ""}`;
    } catch {
      // A Stripe hiccup costs a line of the card row, never the page.
    }
  }

  const policy = resolveEventPolicy(reg.event);
  const ctx = renderableRegistrationState({
    registration: { ...reg, confirmationCode: code },
    event: reg.event,
    club: reg.club,
    activeCount,
    baseUrl: baseUrlFromHeaders(),
    cardLabel,
    location: reg.event.location
      ? {
          name: reg.event.location.name,
          address: reg.event.location.address ?? undefined,
          directionsUrl: reg.event.location.address
            ? `https://maps.google.com/?q=${encodeURIComponent(reg.event.location.address)}`
            : undefined,
        }
      : null,
    cancellationPolicyText: policy.cancellationPolicyText,
  });

  return {
    ctx,
    timeZone: reg.club.timezone,
    eventName: reg.event.name,
    startsAt: reg.event.startsAt,
    endsAt: reg.event.endsAt,
    locationName: reg.event.location?.name ?? null,
    confirmationCode: code,
  };
}
