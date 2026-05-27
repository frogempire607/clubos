// Scoped preview mode. Lets an owner/staff browse the member portal and the
// public surfaces of the app to see what athletes/parents/public users see —
// without logging out, without impersonating anyone, and without bypassing
// real member-only data.
//
// How it works:
//   - We set an `aox_preview` cookie ("member" | "public") on the owner/staff
//     session. The cookie name lives below.
//   - Middleware honors the cookie for owner/staff: when set, the /member/*
//     redirect-to-dashboard guard is skipped so the member layout can render.
//   - Member-portal API routes that strictly require a MEMBER session check
//     this cookie + role and return a sanitized PREVIEW payload (club info
//     only, no real bookings or subscriptions) instead of 401. They never
//     leak another member's data.
//   - The member layout shows a "Preview mode" banner with an Exit button
//     when the cookie is present, so the previewer is always aware.

export const PREVIEW_COOKIE = "aox_preview";
export type PreviewMode = "member" | "public";

export function isValidPreviewMode(v: string | undefined): v is PreviewMode {
  return v === "member" || v === "public";
}

// Server-side helper for App Router route handlers. Pass `request.cookies`
// (next/server Request) or any object with .get(name).
export function readPreviewCookie(
  cookies: { get: (name: string) => { value?: string } | string | undefined },
): PreviewMode | null {
  const raw = (() => {
    const got = cookies.get(PREVIEW_COOKIE);
    if (!got) return undefined;
    if (typeof got === "string") return got;
    return got.value;
  })();
  return isValidPreviewMode(raw) ? raw : null;
}

// Owners and staff are the only roles that may activate preview mode.
export function canStartPreview(role: string | undefined | null): boolean {
  return role === "OWNER" || role === "STAFF";
}
