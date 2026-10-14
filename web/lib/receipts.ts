// Receipt inbox — the PURE part (2026-10-14): what a file name tells us, and
// how likely a bank row is the purchase on a receipt. Suggestions only — a
// receipt is attached to a bank row when the owner confirms it, never by itself.

export type ReceiptHints = { amount: number | null; date: string | null; vendor: string | null };

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

/**
 * "Home Depot 2026-03-14 $84.17.pdf", "receipt_03-14-2026_84.17.jpg",
 * "amazon mar 14 2026 29.99.png" → amount / date / vendor when they are there.
 */
export function receiptHintsFromFileName(fileName: string): ReceiptHints {
  const base = fileName.replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[_]+/g, " ");
  let date: string | null = null;
  let rest = base;
  const take = (re: RegExp, f: (m: RegExpExecArray) => string | null) => {
    const m = re.exec(rest);
    if (!m) return;
    const d = f(m);
    if (d) { date = d; rest = rest.replace(m[0], " "); }
  };
  const pad = (n: number) => String(n).padStart(2, "0");
  const valid = (y: number, mo: number, d: number) => (mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? `${y}-${pad(mo)}-${pad(d)}` : null);
  take(/\b(20\d{2})[-.](\d{1,2})[-.](\d{1,2})\b/, (m) => valid(+m[1], +m[2], +m[3]));
  if (!date) take(/\b(\d{1,2})[-./](\d{1,2})[-./](20\d{2}|\d{2})\b/, (m) => valid(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[1], +m[2]));
  if (!date) take(/\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(20\d{2})\b/i, (m) => valid(+m[3], MONTHS[m[1].toLowerCase()], +m[2]));
  if (!date) take(/\b(20\d{2})(\d{2})(\d{2})\b/, (m) => valid(+m[1], +m[2], +m[3]));
  let amount: number | null = null;
  const money = /\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})|\d+\.\d{2})\b|\b(\d{1,3}(?:,\d{3})*\.\d{2}|\d+\.\d{2})\b/.exec(rest);
  if (money) {
    amount = Number((money[1] ?? money[2]).replace(/,/g, ""));
    rest = rest.replace(money[0], " ");
  }
  const vendor = rest.replace(/\b(receipt|invoice|scan|img|image|photo|copy|final|order)\b/gi, " ").replace(/[^a-z0-9&' ]/gi, " ").replace(/\s+/g, " ").trim();
  return { amount: amount && amount > 0 ? amount : null, date, vendor: vendor && !/^\d+$/.test(vendor) && vendor.length >= 2 ? vendor.slice(0, 80) : null };
}

export type BankRowLite = { id: string; date: string; amount: number; name: string; merchantName: string | null; hasReceipt: boolean };
export type ReceiptLite = { amount: number | null; date: string | null; vendor: string | null };
export type Suggestion = { rowId: string; score: number; why: string[] };

const tokens = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length >= 3 && !["the", "inc", "llc", "com", "www", "pos", "purchase", "debit", "card"].includes(w)));
const days = (a: string, b: string) => Math.abs(Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000));

/** How well one bank row fits one receipt, 0..1, with the reasons in words. */
export function scoreMatch(r: ReceiptLite, row: BankRowLite): Suggestion | null {
  if (row.amount <= 0) return null; // receipts are money out
  const why: string[] = [];
  let score = 0;
  if (r.amount !== null) {
    const diff = Math.abs(row.amount - r.amount);
    if (diff < 0.005) { score += 0.6; why.push("same amount"); }
    else if (diff / r.amount <= 0.25 && diff <= 25) { score += 0.15; why.push(`amount within $${diff.toFixed(2)} (tip or tax?)`); }
    else return null;
  }
  if (r.date) {
    const d = days(r.date, row.date);
    if (d > 7) return null;
    score += 0.25 * (1 - d / 8);
    why.push(d === 0 ? "same day" : `${d} day${d === 1 ? "" : "s"} apart`);
  }
  if (r.vendor) {
    const a = tokens(r.vendor), b = tokens(`${row.merchantName ?? ""} ${row.name}`);
    const common = Array.from(a).filter((t) => b.has(t));
    if (common.length) { score += Math.min(0.3, 0.15 * common.length); why.push(`name: ${common.join(", ")}`); }
  }
  if (row.hasReceipt) score -= 0.1;
  if (score < 0.3) return null;
  return { rowId: row.id, score: Math.min(1, Math.round(score * 100) / 100), why };
}

export function suggestMatches(r: ReceiptLite, rows: readonly BankRowLite[], limit = 3): Suggestion[] {
  if (r.amount === null && !r.date) return [];
  return rows.map((row) => scoreMatch(r, row)).filter((x): x is Suggestion => !!x).sort((a, b) => b.score - a.score).slice(0, limit);
}
