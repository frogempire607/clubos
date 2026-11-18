"use client";

// "Back returns to the list at the same place." A list that loads its rows
// after the page appears has no height when the browser tries to restore the
// scroll position, so the browser's own restore lands at the top. The list
// remembers where it was when a row is opened, and puts itself back there
// once its rows have loaded. Per tab (sessionStorage), best-effort.

const KEY = (list: string) => `aox-scroll:${list}`;

export function rememberScroll(list: string): void {
  try {
    sessionStorage.setItem(KEY(list), String(Math.round(window.scrollY)));
  } catch {
    /* storage unavailable */
  }
}

/** Call once the list's rows are on screen. Restores and forgets. */
export function restoreScroll(list: string): void {
  try {
    const raw = sessionStorage.getItem(KEY(list));
    if (raw == null) return;
    sessionStorage.removeItem(KEY(list));
    const y = Number(raw);
    if (Number.isFinite(y) && y > 0) requestAnimationFrame(() => window.scrollTo(0, y));
  } catch {
    /* storage unavailable */
  }
}
