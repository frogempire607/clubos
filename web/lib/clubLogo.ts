import { getEmailBaseUrl } from "@/lib/baseUrl";

// A club's logo is stored as `Club.logoUrl`, which is normally our private,
// session-gated `/api/files/<id>` path (or, for some clubs, an external absolute
// URL they pasted). That private path is useless in two places:
//   1. Emails — an <img src="/api/files/..."> has no origin to resolve against,
//      and even absolute it 401s because /api/files requires a logged-in session.
//   2. Public pages (e.g. the activation page) viewed by a logged-out member.
//
// publicClubLogoUrl() returns an ABSOLUTE, UNAUTHENTICATED URL safe for both:
// external logos pass through untouched; our /api/files logos are rewritten to
// the public /api/public/club-logo/<clubId> endpoint.
//
// Uses getEmailBaseUrl() (production origin) rather than getAppBaseUrl()
// so a logo <img src="..."> in an email renders correctly on Gmail from
// any dev/preview/production environment — Gmail's fetcher can't reach a
// LAN IP or a Netlify preview URL. The activation/reactivation pages
// that also call this helper are on the same production origin, so
// nothing regresses there.
export function publicClubLogoUrl(
  clubId: string,
  logoUrl: string | null | undefined,
): string {
  // Externally-hosted absolute logo — already loadable anywhere.
  if (logoUrl && /^https?:\/\//i.test(logoUrl)) return logoUrl;
  // Anything else (our /api/files/... path, or no logo at all) → the public
  // endpoint, which serves the club's own logo or falls back to the AthletixOS
  // default mark. Never null, so emails/link pages never render a broken "?".
  return `${getEmailBaseUrl()}/api/public/club-logo/${clubId}`;
}
