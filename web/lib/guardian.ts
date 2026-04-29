import { prisma } from "./prisma";

function splitName(fullName: string | null | undefined): { firstName: string; lastName: string } {
  const name = (fullName || "").trim();
  if (!name) return { firstName: "Guardian", lastName: "" };
  const parts = name.split(/\s+/);
  return {
    firstName: parts[0] || "Guardian",
    lastName: parts.slice(1).join(" ") || "",
  };
}

export type GuardianInput = {
  guardianName?: string | null;
  guardianEmail?: string | null;
  guardianPhone?: string | null;
};

/**
 * Look up an existing Guardian profile by clubId + email (case-insensitive),
 * or create one if none exists. Returns null when guardian email is missing —
 * the caller should clear guardianId in that case.
 */
export async function upsertGuardianProfile(
  clubId: string,
  input: GuardianInput
): Promise<{ id: string; firstName: string; lastName: string; email: string; phone: string } | null> {
  const email = input.guardianEmail?.trim().toLowerCase() || "";
  if (!email) return null;

  const { firstName, lastName } = splitName(input.guardianName);
  const phone = input.guardianPhone?.trim() || "";

  const existing = await prisma.guardian.findUnique({
    where: { clubId_email: { clubId, email } },
  });

  if (existing) {
    // Patch name/phone only when caller supplied them and existing fields are blank.
    const patchData: Record<string, string> = {};
    if (input.guardianName && (!existing.firstName || existing.firstName === "Guardian") && firstName) {
      patchData.firstName = firstName;
    }
    if (input.guardianName && !existing.lastName && lastName) {
      patchData.lastName = lastName;
    }
    if (phone && !existing.phone) patchData.phone = phone;

    if (Object.keys(patchData).length > 0) {
      const updated = await prisma.guardian.update({
        where: { id: existing.id },
        data: patchData,
      });
      return updated;
    }
    return existing;
  }

  return prisma.guardian.create({
    data: { clubId, firstName, lastName, email, phone },
  });
}
