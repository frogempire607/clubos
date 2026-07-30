// Reports Phase 2.5.10 — import wizard core.
//
// Everything the wizard needs that isn't a network handler:
//   - column alias tables (member + transaction), per specs/04
//   - normalizers (email/phone/date)
//   - matching-signal detection
//   - merge semantics (survivor = native; never overwrite non-empty native)
//   - error/warning classification
//
// No prisma calls here — pure helpers so unit tests don't need a DB.

import crypto from "crypto";

// ── Field alias tables (spec/04) ───────────────────────────────────────

export type MemberFieldKey =
  | "firstName" | "lastName" | "email" | "phone" | "dateOfBirth"
  | "joinDate" | "membershipStartDate" | "membershipEndDate" | "membershipType"
  | "memberStatus" | "role" | "externalMemberId" | "notes";

export const MEMBER_FIELDS: Array<{ key: MemberFieldKey; label: string; aliases: string[]; required?: boolean }> = [
  { key: "firstName",         label: "First name",         aliases: ["first name", "firstname", "given name", "fname", "first"] },
  { key: "lastName",          label: "Last name",          aliases: ["last name", "lastname", "surname", "family name", "lname", "last"] },
  { key: "email",             label: "Email",              aliases: ["email", "email address", "e-mail", "primary email", "mail"] },
  { key: "phone",             label: "Phone",              aliases: ["phone", "mobile", "cell", "phone number", "cellphone", "mobile number"] },
  { key: "dateOfBirth",       label: "Date of birth",      aliases: ["dob", "birthdate", "date of birth", "birthday", "birth"] },
  { key: "joinDate",          label: "Join date",          aliases: ["join date", "client since", "member since", "start", "signup date"] },
  { key: "membershipStartDate", label: "Membership start", aliases: ["pass start", "membership start", "start date"] },
  { key: "membershipEndDate", label: "Membership end",     aliases: ["pass end", "membership end", "expiry", "expiration", "end date"] },
  { key: "membershipType",    label: "Membership type",    aliases: ["pass name", "membership", "plan", "program", "package"] },
  { key: "memberStatus",      label: "Status",             aliases: ["status", "active", "state", "member status"] },
  { key: "role",              label: "Role",               aliases: ["type", "rel type", "relationship", "athlete/parent", "role"] },
  { key: "externalMemberId",  label: "Legacy ID",          aliases: ["client id", "member id", "customer id", "id", "legacy id"] },
  { key: "notes",             label: "Notes",              aliases: ["notes", "comments", "memo", "note"] },
];

export type TransactionFieldKey =
  | "transactionDate" | "clientName" | "athleteName" | "email"
  | "externalCustomerId" | "externalTransactionId" | "itemPurchased"
  | "paymentMethod" | "grossAmount" | "refundAmount" | "processingFee"
  | "netAmount" | "status" | "notes";

export const TRANSACTION_FIELDS: Array<{ key: TransactionFieldKey; label: string; aliases: string[] }> = [
  { key: "transactionDate",      label: "Date",              aliases: ["date", "transaction date", "purchase date", "sale date", "when"] },
  { key: "clientName",           label: "Payer name",        aliases: ["client name", "customer", "payer", "customer name", "name"] },
  { key: "athleteName",          label: "Athlete name",      aliases: ["athlete name", "student name", "for", "on behalf of"] },
  { key: "email",                label: "Email",             aliases: ["email", "email address"] },
  { key: "externalCustomerId",   label: "Legacy customer id", aliases: ["client id", "customer id", "customer_id"] },
  { key: "externalTransactionId", label: "Legacy tx id",     aliases: ["transaction id", "tx id", "invoice id", "receipt id", "id"] },
  { key: "itemPurchased",        label: "Item purchased",    aliases: ["item", "product", "membership", "purchased", "description"] },
  { key: "paymentMethod",        label: "Payment method",    aliases: ["method", "payment method", "type", "payment type"] },
  { key: "grossAmount",          label: "Gross amount",      aliases: ["gross", "gross amount", "amount", "total", "price"] },
  { key: "refundAmount",         label: "Refund",            aliases: ["refund", "refund amount", "refunded"] },
  { key: "processingFee",        label: "Processing fee",    aliases: ["fee", "processing fee", "stripe fee"] },
  { key: "netAmount",            label: "Net amount",        aliases: ["net", "net amount", "net total"] },
  { key: "status",               label: "Status",            aliases: ["status", "state"] },
  { key: "notes",                label: "Notes",             aliases: ["notes", "memo", "comments", "note"] },
];

const norm = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export type SuggestedMap = Record<string, string | null>; // csvHeader → fieldKey|null

export function autoMapMemberHeaders(headers: string[]): SuggestedMap {
  const map: SuggestedMap = {};
  for (const h of headers) {
    const n = norm(h);
    const match = MEMBER_FIELDS.find((f) =>
      f.aliases.some((a) => norm(a) === n || n.includes(norm(a)) || norm(a).includes(n)),
    );
    map[h] = match?.key ?? null;
  }
  return map;
}

export function autoMapTransactionHeaders(headers: string[]): SuggestedMap {
  const map: SuggestedMap = {};
  for (const h of headers) {
    const n = norm(h);
    const match = TRANSACTION_FIELDS.find((f) =>
      f.aliases.some((a) => norm(a) === n || n.includes(norm(a)) || norm(a).includes(n)),
    );
    map[h] = match?.key ?? null;
  }
  return map;
}

// ── Normalizers ────────────────────────────────────────────────────────

export function normalizeEmail(e: string | null | undefined): string | null {
  if (!e) return null;
  const t = e.trim().toLowerCase();
  if (t.length === 0) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) return null;
  return t;
}

export function normalizePhone(p: string | null | undefined): string | null {
  if (!p) return null;
  const digits = p.replace(/\D+/g, "");
  return digits.length > 0 ? digits : null;
}

export function normalizeStatus(s: string | null | undefined): string {
  if (!s) return "UNKNOWN";
  const l = s.trim().toLowerCase();
  if (["active", "current", "enrolled"].includes(l)) return "ACTIVE";
  if (["inactive", "cancelled", "canceled", "expired", "former", "archived"].includes(l)) return "INACTIVE";
  if (["hold", "paused", "frozen", "suspended"].includes(l)) return "PAUSED";
  return "INACTIVE";
}

// Try to parse a date in the given format. Format is one of: MDY / DMY / YMD.
// Fallback to Date.parse on failure.
export function parseDateWith(raw: string | null | undefined, format: "MDY" | "DMY" | "YMD" = "MDY"): Date | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  const parts = s.split(/[\/\-.]/);
  if (parts.length === 3) {
    let year: number, month: number, day: number;
    const [a, b, c] = parts.map((p) => parseInt(p, 10));
    if ([a, b, c].some((n) => Number.isNaN(n))) return null;
    if (format === "MDY") { year = c < 100 ? 2000 + c : c; month = a; day = b; }
    else if (format === "DMY") { year = c < 100 ? 2000 + c : c; month = b; day = a; }
    else { year = a; month = b; day = c; }
    const d = new Date(Date.UTC(year, month - 1, day));
    if (Number.isNaN(d.getTime())) return null;
    return d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Infer the most likely date format by scanning a column of values. If any
// value has a first component > 12, the format is unambiguous.
export function inferDateFormat(samples: Array<string | null | undefined>, defaultFormat: "MDY" | "DMY" | "YMD" = "MDY"): "MDY" | "DMY" | "YMD" {
  let dmyEvidence = 0;
  let mdyEvidence = 0;
  let ymdEvidence = 0;
  for (const s of samples) {
    if (!s) continue;
    const parts = s.trim().split(/[\/\-.]/).map((p) => parseInt(p, 10));
    if (parts.length !== 3) continue;
    const [a, b, c] = parts;
    if (a >= 100 || (a > 31 && a < 100)) ymdEvidence += 1;
    else if (a > 12) dmyEvidence += 1;
    else if (b > 12) mdyEvidence += 1;
  }
  if (ymdEvidence > dmyEvidence && ymdEvidence > mdyEvidence) return "YMD";
  if (dmyEvidence > mdyEvidence) return "DMY";
  if (mdyEvidence > 0) return "MDY";
  return defaultFormat;
}

// Money — accepts "$1,234.56" or "1234.56" or "(1,234.56)" for negatives.
export function parseMoney(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  let sign = 1;
  if (/^\(.*\)$/.test(s)) { sign = -1; s = s.slice(1, -1); }
  s = s.replace(/[$,\s]/g, "");
  if (/^[-−]/.test(s)) { sign = -1; s = s.slice(1); }
  const n = Number(s);
  return Number.isNaN(n) ? null : n * sign;
}

// Composite fingerprint for transaction dedup when there's no external id.
export function makeDedupeHash(input: {
  clubId: string;
  date: string; // YYYY-MM-DD
  amount: number;
  normalizedPayerEmail: string | null;
  itemLabel: string | null;
}): string {
  const raw = [input.clubId, input.date, input.amount.toFixed(2), input.normalizedPayerEmail ?? "", input.itemLabel ?? ""].join("|");
  return crypto.createHash("sha256").update(raw).digest("hex");
}

// ── CSV parsing (tiny, permissive; handles quoted values + commas) ────

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let cur: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 1; }
        else inQuotes = false;
      } else cell += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ",") { cur.push(cell); cell = ""; continue; }
    if (c === "\n") {
      cur.push(cell);
      // Skip blank trailing rows.
      if (cur.length !== 1 || cur[0].trim() !== "") rows.push(cur);
      cur = []; cell = "";
      continue;
    }
    if (c === "\r") continue;
    cell += c;
  }
  if (cell.length > 0 || cur.length > 0) {
    cur.push(cell);
    if (cur.length !== 1 || cur[0].trim() !== "") rows.push(cur);
  }
  return rows;
}

// ── Error & warning classification (specs/04 §step 3) ──────────────────

export type RowError = { field?: string; message: string };
export type RowValidation = { errors: RowError[]; warnings: RowError[] };

export function validateMemberRow(
  values: Record<string, string | null | undefined>,
  fields: Record<string, MemberFieldKey | null>,
  dateFormat: "MDY" | "DMY" | "YMD",
): RowValidation {
  const errors: RowError[] = [];
  const warnings: RowError[] = [];
  const get = (k: MemberFieldKey) => {
    for (const header in fields) if (fields[header] === k) return values[header];
    return undefined;
  };
  const firstName = get("firstName")?.trim();
  const lastName = get("lastName")?.trim();
  const email = normalizeEmail(get("email"));
  const externalId = get("externalMemberId")?.trim();
  if (!firstName && !email && !externalId) {
    errors.push({ message: "No name, email, or external ID — cannot identify this person." });
  }
  const dobRaw = get("dateOfBirth");
  if (dobRaw) {
    const dob = parseDateWith(dobRaw, dateFormat);
    if (!dob) errors.push({ field: "dateOfBirth", message: "Unparseable date of birth." });
    else {
      const now = new Date();
      if (dob > now) warnings.push({ field: "dateOfBirth", message: "Date of birth in the future." });
      const age = (now.getFullYear() - dob.getFullYear());
      if (age > 100) warnings.push({ field: "dateOfBirth", message: "Age > 100 years — verify." });
    }
  }
  const start = get("membershipStartDate") ? parseDateWith(get("membershipStartDate"), dateFormat) : null;
  const end = get("membershipEndDate") ? parseDateWith(get("membershipEndDate"), dateFormat) : null;
  if (start && end && end < start) {
    errors.push({ message: "Membership end date before start date." });
  }
  if (!get("joinDate")) warnings.push({ field: "joinDate", message: "Missing join date." });
  if (!get("membershipType")) warnings.push({ field: "membershipType", message: "Missing membership type." });
  const statusRaw = get("memberStatus");
  if (statusRaw && normalizeStatus(statusRaw) === "INACTIVE" && !["inactive", "cancelled", "canceled", "expired", "former", "archived"].includes(statusRaw.trim().toLowerCase())) {
    warnings.push({ field: "memberStatus", message: `Unrecognized status "${statusRaw}" — mapped to INACTIVE.` });
  }
  const phone = get("phone");
  if (phone && normalizePhone(phone) === null) {
    warnings.push({ field: "phone", message: "Phone couldn't be normalized." });
  }
  return { errors, warnings };
}

export function validateTransactionRow(
  values: Record<string, string | null | undefined>,
  fields: Record<string, TransactionFieldKey | null>,
  dateFormat: "MDY" | "DMY" | "YMD",
): RowValidation {
  const errors: RowError[] = [];
  const warnings: RowError[] = [];
  const get = (k: TransactionFieldKey) => {
    for (const header in fields) if (fields[header] === k) return values[header];
    return undefined;
  };
  const dateRaw = get("transactionDate");
  const date = parseDateWith(dateRaw, dateFormat);
  if (!date) errors.push({ field: "transactionDate", message: "Unparseable date." });
  const gross = parseMoney(get("grossAmount"));
  if (gross == null) errors.push({ field: "grossAmount", message: "Non-numeric amount." });
  const refund = parseMoney(get("refundAmount"));
  const fee = parseMoney(get("processingFee"));
  const net = parseMoney(get("netAmount"));
  if (gross != null && refund != null && fee != null && net != null) {
    const expected = gross - Math.abs(refund) - Math.abs(fee);
    if (Math.abs(expected - net) > 0.02) {
      warnings.push({ message: `Net doesn't reconcile (gross ${gross} − refund ${Math.abs(refund)} − fee ${Math.abs(fee)} ≠ ${net}).` });
    }
  }
  return { errors, warnings };
}
