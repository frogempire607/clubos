// B21 — every time on the staff profile displays as 12-hour AM/PM.
// Storage stays "HH:mm" (24h); this is display only. Pure.

export function to12h(hhmm: string | null | undefined): string {
  if (!hhmm) return "";
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm.trim());
  if (!m) return hhmm;
  const h = Number(m[1]);
  const min = m[2];
  if (h > 23 || Number(min) > 59) return hhmm;
  const mer = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${min} ${mer}`;
}

/** "18:30","20:30" → "6:30 – 8:30 PM"; "11:00","13:00" → "11:00 AM – 1:00 PM". */
export function range12h(start: string | null | undefined, end: string | null | undefined): string {
  const a = to12h(start);
  const b = to12h(end);
  if (!a) return b;
  if (!b) return a;
  const am = a.slice(-2);
  const bm = b.slice(-2);
  if (am === bm) return `${a.slice(0, -3)} – ${b}`;
  return `${a} – ${b}`;
}
