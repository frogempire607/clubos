import { isValidEmail } from "./migration";

export type MemberContactInput = {
  isMinor: boolean;
  email?: string | null;
  phone?: string | null;
  guardianName?: string | null;
  guardianEmail?: string | null;
};

export function normalizeEmail(raw: string | null | undefined): string | null {
  const email = raw?.trim().toLowerCase() || "";
  return isValidEmail(email) ? email : null;
}

export function normalizePhone(raw: string | null | undefined): string | null {
  return raw?.trim() || null;
}

export function validateMemberContact(input: MemberContactInput): string | null {
  if (input.isMinor) {
    if (!input.guardianName?.trim()) return "Guardian name is required for minors.";
    if (!normalizeEmail(input.guardianEmail)) return "Guardian email is required for minors.";
    return null;
  }

  if (!normalizeEmail(input.email) && !normalizePhone(input.phone)) {
    return "Adult members need an email or phone.";
  }
  return null;
}

export function normalizeImportedMemberContact(input: {
  email?: string | null;
  phone?: string | null;
  guardianEmail?: string | null;
  guardianPhone?: string | null;
  isMinor: boolean;
}) {
  const memberEmail = normalizeEmail(input.email);
  const memberPhone = normalizePhone(input.phone);
  let guardianEmail = normalizeEmail(input.guardianEmail);
  let guardianPhone = normalizePhone(input.guardianPhone);

  if (input.isMinor) {
    if (!guardianEmail && memberEmail) guardianEmail = memberEmail;
    if (!guardianPhone && memberPhone) guardianPhone = memberPhone;
    return {
      email: null,
      phone: null,
      guardianEmail,
      guardianPhone,
    };
  }

  return {
    email: memberEmail,
    phone: memberPhone,
    guardianEmail,
    guardianPhone,
  };
}
