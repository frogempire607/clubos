// "2026-09-01" → "Sep" for chart axes. PURE.
//
// Parsed as a calendar date on purpose: `new Date("2026-09-01")` is UTC
// midnight, which is Aug 31 in every US time zone, so the Snapshot bars were
// labelled one month early.
export function monthLabel(isoDate: string): string {
  const [y, m] = isoDate.slice(0, 7).split("-").map(Number);
  if (!y || !m) return "";
  return new Date(y, m - 1, 15).toLocaleDateString("en-US", { month: "short" });
}
