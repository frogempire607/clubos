// Account-level "active athlete profile" for the member portal.
//
// A guardian account can manage several linked athletes (themselves + each
// linked child). This module keeps the currently-selected profile in
// localStorage so the choice is shared across every portal page instead of
// each page tracking its own switcher independently.

const KEY = "athletixos-active-profile";
const EVT = "athletixos-active-profile-change";

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
export function resolveActiveProfileId(accessibleIds: string[]): string | null {
  const stored = getActiveProfileId();
  if (stored && accessibleIds.includes(stored)) return stored;
  return accessibleIds[0] ?? null;
}
