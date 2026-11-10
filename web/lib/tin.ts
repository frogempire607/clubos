// Phase 12.1 — tax identification numbers: shape, validation, masking. PURE.
//
// No crypto, no prisma, no clock, so the rules can be proven without a key.
// lib/fieldCrypto.ts does the encryption; lib/contractorTin.ts is the only
// module that puts the two together.
//
// Nothing here logs, and nothing here returns a full TIN in an error message.

export type TinKind = "SSN" | "EIN";
export const TIN_KINDS: TinKind[] = ["SSN", "EIN"];

export function isTinKind(v: string | null | undefined): v is TinKind {
  return v === "SSN" || v === "EIN";
}

/// Digits only. Accepts what people actually type: "123-45-6789",
/// "123 45 6789", "12-3456789".
export function normalizeTin(raw: string): string {
  return (raw ?? "").replace(/\D/g, "");
}

/// Validation errors, empty when the value is acceptable.
///
/// ── WHAT IS AND IS NOT ENFORCED ─────────────────────────────────────────────
/// Enforced for an SSN, from the Social Security Administration's own rules:
/// nine digits; the area (first three) is never 000, 666, or 900–999; the
/// group (middle two) is never 00; the serial (last four) is never 0000.
/// These catch real typos and the placeholder numbers people type to get past
/// a form.
///
/// NOT enforced for an EIN: the IRS campus prefix list. It is long, it changes
/// as the IRS reassigns prefixes, and a stale copy here would reject a
/// legitimate contractor's real EIN — which is a worse failure than accepting
/// a typo that the IRS will bounce at filing time. Nine digits and a non-zero
/// prefix is the line.
export function validateTin(raw: string, kind: TinKind): string[] {
  const digits = normalizeTin(raw);
  const errs: string[] = [];

  if (digits.length === 0) {
    errs.push(kind === "SSN" ? "Enter your Social Security number." : "Enter your Employer Identification Number.");
    return errs;
  }
  if (digits.length !== 9) {
    errs.push(
      kind === "SSN"
        ? `A Social Security number is nine digits — that one has ${digits.length}.`
        : `An Employer Identification Number is nine digits — that one has ${digits.length}.`,
    );
    return errs;
  }
  // A single repeated digit is never a real TIN and is what gets typed to skip
  // a field.
  if (/^(\d)\1{8}$/.test(digits)) {
    errs.push("That isn't a valid number — every digit is the same.");
    return errs;
  }

  if (kind === "SSN") {
    const area = digits.slice(0, 3);
    const group = digits.slice(3, 5);
    const serial = digits.slice(5);
    if (area === "000") errs.push("A Social Security number can't start with 000.");
    else if (area === "666") errs.push("A Social Security number can't start with 666.");
    else if (Number(area) >= 900) errs.push("A Social Security number can't start with 900 or higher.");
    if (group === "00") errs.push("The middle two digits of a Social Security number can't be 00.");
    if (serial === "0000") errs.push("The last four digits of a Social Security number can't be 0000.");
  } else {
    if (digits.slice(0, 2) === "00") errs.push("An Employer Identification Number can't start with 00.");
  }
  return errs;
}

export function tinLast4(raw: string): string {
  const digits = normalizeTin(raw);
  return digits.slice(-4);
}

/// How a TIN is written on a form. Used for the PDF, never for storage.
export function formatTin(raw: string, kind: TinKind): string {
  const d = normalizeTin(raw);
  if (d.length !== 9) return d;
  return kind === "SSN" ? `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}` : `${d.slice(0, 2)}-${d.slice(2)}`;
}

/// What every screen shows. Built from the stored plaintext last-4 ONLY, so
/// displaying a masked TIN never requires a decryption call — which is how a
/// decrypt ends up in a log line.
export function maskedTin(last4: string | null | undefined, kind: TinKind | null | undefined): string {
  if (!last4 || last4.length !== 4) return "Not on file";
  return kind === "EIN" ? `••-•••${last4}` : `•••-••-${last4}`;
}

// ── W-9 federal tax classification (line 3 of the form) ─────────────────────

export const TAX_CLASSIFICATIONS = [
  { key: "INDIVIDUAL", label: "Individual" },
  { key: "SOLE_PROPRIETOR", label: "Sole proprietor" },
  { key: "SINGLE_MEMBER_LLC", label: "Single-member LLC (disregarded entity)" },
  { key: "C_CORP", label: "C corporation" },
  { key: "S_CORP", label: "S corporation" },
  { key: "PARTNERSHIP", label: "Partnership" },
  { key: "TRUST_ESTATE", label: "Trust or estate" },
  { key: "LLC_C", label: "LLC taxed as a C corporation" },
  { key: "LLC_S", label: "LLC taxed as an S corporation" },
  { key: "LLC_P", label: "LLC taxed as a partnership" },
  { key: "OTHER", label: "Other" },
] as const;

export type TaxClassification = (typeof TAX_CLASSIFICATIONS)[number]["key"];

export function isTaxClassification(v: string | null | undefined): v is TaxClassification {
  return TAX_CLASSIFICATIONS.some((c) => c.key === v);
}

export function taxClassificationLabel(key: string | null | undefined): string {
  return TAX_CLASSIFICATIONS.find((c) => c.key === key)?.label ?? "—";
}

/// Which classifications normally carry an EIN rather than an SSN. Used to
/// pick the default, never to refuse: a sole proprietor may legitimately have
/// either, and the IRS instructions say so.
export function suggestsEin(classification: string | null | undefined): boolean {
  return ["C_CORP", "S_CORP", "PARTNERSHIP", "TRUST_ESTATE", "LLC_C", "LLC_S", "LLC_P"].includes(
    classification ?? "",
  );
}

// ── The certification ───────────────────────────────────────────────────────

/// The text a contractor agrees to, taken from Form W-9's Part II.
///
/// SNAPSHOTTED onto every submission. If this copy is ever edited, what people
/// previously certified must not change with it — so the stored text is what
/// counts and this constant is only what the NEXT person will sign.
export const W9_CERTIFICATION_TEXT = `Under penalties of perjury, I certify that:

1. The number shown on this form is my correct taxpayer identification number (or I am waiting for a number to be issued to me); and
2. I am not subject to backup withholding because: (a) I am exempt from backup withholding, or (b) I have not been notified by the Internal Revenue Service (IRS) that I am subject to backup withholding as a result of a failure to report all interest or dividends, or (c) the IRS has notified me that I am no longer subject to backup withholding; and
3. I am a U.S. citizen or other U.S. person; and
4. The FATCA code(s) entered on this form (if any) indicating that I am exempt from FATCA reporting is correct.`;

/// The line the IRS requires an electronic signature to be accompanied by.
export const W9_ESIGN_NOTICE =
  "Typing your name below and submitting this form is your electronic signature. It has the same legal effect as signing a paper Form W-9.";

export type W9Draft = {
  legalName: string;
  businessName?: string | null;
  taxClassification: string;
  classificationNote?: string | null;
  streetAddress: string;
  city: string;
  state: string;
  zipCode: string;
  taxIdKind: string;
  taxId: string;
  signedName: string;
};

/// Everything wrong with a submission, all at once — so a contractor fixes one
/// form rather than being told about one field at a time.
export function validateW9(draft: W9Draft): string[] {
  const errs: string[] = [];
  if (!draft.legalName?.trim()) errs.push("Enter the name on your income tax return.");
  else if (draft.legalName.trim().length > 200) errs.push("That name is too long.");

  if (!isTaxClassification(draft.taxClassification)) errs.push("Choose a federal tax classification.");
  else if (draft.taxClassification === "OTHER" && !draft.classificationNote?.trim()) {
    errs.push('Describe your classification, since you chose "Other".');
  }

  if (!draft.streetAddress?.trim()) errs.push("Enter your street address.");
  if (!draft.city?.trim()) errs.push("Enter your city.");
  if (!draft.state?.trim()) errs.push("Enter your state.");
  if (!draft.zipCode?.trim()) errs.push("Enter your ZIP code.");
  else if (!/^\d{5}(-\d{4})?$/.test(draft.zipCode.trim())) errs.push("Enter a ZIP code as 12345 or 12345-6789.");

  if (!isTinKind(draft.taxIdKind)) errs.push("Say whether that is a Social Security number or an EIN.");
  else errs.push(...validateTin(draft.taxId ?? "", draft.taxIdKind));

  if (!draft.signedName?.trim()) errs.push("Type your name to sign the form.");
  else if (draft.signedName.trim().length > 200) errs.push("That signature is too long.");

  return errs;
}

/// A signature must plausibly be the person certifying. Compared loosely —
/// letters only, case- and punctuation-insensitive — because "Dana O'Brien"
/// signing "Dana OBrien" is the same person, and refusing that helps nobody.
export function signatureMatchesName(signedName: string, legalName: string): boolean {
  const norm = (s: string) => (s ?? "").toLowerCase().replace(/[^a-z]/g, "");
  const a = norm(signedName);
  const b = norm(legalName);
  if (!a || !b) return false;
  return a === b;
}
