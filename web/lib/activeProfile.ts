// Account-level "active athlete profile" for the member portal.
//
// A guardian account can manage several linked athletes (themselves + each
// linked child). This module keeps the currently-selected profile in
// localStorage so the choice is shared across every portal page instead of
// each page tracking its own switcher independently.

const KEY = "athletixos-active-profile";
const EVT = "athletixos-active-profile-change";

/**
 * Sentinel selection meaning "every athlete this account manages", stored in
 * the same slot as a real member id.
 *
 * Why it exists: every booking surface used to be scoped to ONE athlete, so a
 * guardian who booked two children saw one booking at a time and reasonably
 * concluded the second had failed. That is exactly what happened to the Hall
 * family on 2026-08-17 — both bookings landed 38 seconds apart and the parent
 * reported one missing. The server was never wrong; the view was.
 *
 * It is deliberately NOT a valid member id (double underscores), so a stale
 * value can never collide with a real row, and `accessibleIds.includes(...)`
 * checks reject it unless the caller opts in via `allowFamily`.
 */
export const FAMILY_SCOPE = "__family__";

export function isFamilyScope(id: string | null | undefined): boolean {
  return id === FAMILY_SCOPE;
}

export function getActiveProfileId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setActiveProfileId(id: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (id) window.localStorage.setItem(KEY, id);
    else window.localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable — selection just won't persist */
  }
  window.dispatchEvent(new CustomEvent(EVT, { detail: id }));
}

// Subscribe to selection changes (same tab via CustomEvent, other tabs via
// the native `storage` event). Returns an unsubscribe function.
export function onActiveProfileChange(cb: (id: string | null) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onCustom = (e: Event) => cb((e as CustomEvent).detail ?? null);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) cb(e.newValue);
  };
  window.addEventListener(EVT, onCustom);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVT, onCustom);
    window.removeEventListener("storage", onStorage);
  };
}

// Pick the profile to show: a persisted choice if it's still one of the
// accessible profiles, otherwise the first (self) profile.
//
// `allowFamily` — this surface can render the family scope, so a stored
//   FAMILY_SCOPE is honored. Callers that are legitimately per-child
//   (documents, parental controls, billing) leave it off and a stored family
//   selection quietly falls back to a real athlete.
// `defaultFamily` — with nothing stored, start in family scope. Callers pass
//   `familyEligible(...)` so this only fires for the multi-child families the
//   scope exists for.
export function resolveActiveProfileId(
  accessibleIds: string[],
  opts?: { allowFamily?: boolean; defaultFamily?: boolean },
): string | null {
  const stored = getActiveProfileId();
  if (opts?.allowFamily && isFamilyScope(stored)) return FAMILY_SCOPE;
  if (stored && accessibleIds.includes(stored)) return stored;
  if (opts?.allowFamily && opts?.defaultFamily) return FAMILY_SCOPE;
  return accessibleIds[0] ?? null;
}

/**
 * Does this account get the family scope at all?
 *
 * Two or more CHILDREN — not merely two profiles. An adult who trains and has
 * one child keeps the exact behavior they have today: no family option, no
 * new default, nothing to re-learn. The scope exists for the parent juggling
 * siblings, and that is the only account it changes.
 */
export function familyEligible(profiles: { kind: "self" | "child" }[]): boolean {
  return profiles.filter((p) => p.kind === "child").length >= 2;
}
