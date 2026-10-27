// Phase 12.1 Part 3 — employee or contractor. PURE rules plus the one write.
//
// ── WHY THIS IS NULLABLE AND HAS NO DEFAULT ─────────────────────────────────
// Worker classification is a legal determination with tax consequences —
// payroll withholding on one side, a 1099 on the other, and real penalties for
// getting it wrong. AthletixOS must not make that determination for a club by
// defaulting everybody to one or the other, so an unclassified staff member
// stays unclassified and every surface says so out loud.
//
// The 1099 report reads this: a staff member classified EMPLOYEE is excluded
// from it entirely, because their pay belongs on a W-2.

import { prisma } from "@/lib/prisma";

export const WORKER_TYPES = ["EMPLOYEE", "CONTRACTOR"] as const;
export type WorkerType = (typeof WORKER_TYPES)[number];

export function isWorkerType(v: string | null | undefined): v is WorkerType {
  return v === "EMPLOYEE" || v === "CONTRACTOR";
}

export function workerTypeLabel(v: string | null | undefined): string {
  if (v === "EMPLOYEE") return "Employee";
  if (v === "CONTRACTOR") return "Contractor";
  return "Not set";
}

export function workerTypeDescription(v: string | null | undefined): string {
  if (v === "EMPLOYEE") return "Paid through payroll. No W-9 or 1099.";
  if (v === "CONTRACTOR") return "Completes a W-9 and may receive a 1099.";
  return "Nobody has classified this person yet, so they appear in neither payroll nor 1099 reporting.";
}

/// The line shown wherever this is set. Short on purpose: it has to be read,
/// not skimmed past, and it must not pretend to be legal advice.
export const CLASSIFICATION_NOTE =
  "Whether someone is an employee or a contractor is your determination as the club, not something AthletixOS decides. The IRS looks at how much control you have over the work. If you're unsure, ask your accountant.";

export type WorkerActor = { userId: string | null; name: string | null };

/// Set a staff member's worker type.
///
/// Setting CONTRACTOR makes sure there is a Contractor record linked to them,
/// reusing the EXISTING link: `Contractor.convertedUserId` already means "this
/// contractor is also this staff user", and it is unique. One contractor
/// record per staff user, read from either direction.
///
/// Setting EMPLOYEE does NOT delete the Contractor record. It may carry
/// payment history, and money outlives a classification — the 1099 report
/// excludes them by worker type instead.
export async function setWorkerType(
  clubId: string,
  staffUserId: string,
  workerType: WorkerType,
  actor: WorkerActor,
): Promise<{ workerType: WorkerType; contractorId: string | null }> {
  const user = await prisma.user.findFirst({
    where: { id: staffUserId, clubId, deletedAt: null },
    select: { id: true, firstName: true, lastName: true, email: true, staffProfile: { select: { userId: true } } },
  });
  if (!user) throw new Error("That staff member doesn't exist.");

  await prisma.staffProfile.upsert({
    where: { userId: user.id },
    create: { userId: user.id, workerType, permissions: {} },
    update: { workerType },
  });

  const contractorId =
    workerType === "CONTRACTOR"
      ? await ensureContractorLink(clubId, user.id)
      : (
          await prisma.contractor.findFirst({
            where: { clubId, convertedUserId: user.id },
            select: { id: true },
          })
        )?.id ?? null;

  return { workerType, contractorId };
}

/// Make sure a staff user has a Contractor record, and return its id.
///
/// Reuses the EXISTING link: `Contractor.convertedUserId` already means "this
/// contractor is also this staff user", and it is unique, so there is one
/// record per person readable from either direction.
///
/// A previously removed record is restored rather than a second one created
/// beside it. Two contractor rows for one person would split their payment
/// history, and the half the 1099 report happened to read would be the number
/// on the form.
export async function ensureContractorLink(clubId: string, staffUserId: string): Promise<string> {
  const existing = await prisma.contractor.findFirst({
    where: { clubId, convertedUserId: staffUserId },
    select: { id: true, deletedAt: true },
  });
  if (existing) {
    if (existing.deletedAt) {
      await prisma.contractor.update({
        where: { id: existing.id },
        data: { deletedAt: null, active: true },
      });
    }
    return existing.id;
  }

  const user = await prisma.user.findFirst({
    where: { id: staffUserId, clubId },
    select: { firstName: true, lastName: true, email: true },
  });
  const name = `${user?.firstName ?? ""} ${user?.lastName ?? ""}`.trim() || user?.email || "Contractor";
  const created = await prisma.contractor.create({
    data: {
      clubId,
      name,
      email: user?.email ?? null,
      convertedUserId: staffUserId,
      payoutNotes: `Linked to the staff account for ${name}.`,
    },
    select: { id: true },
  });
  return created.id;
}

/// The contractor record linked to a staff user, if any. The lookup both
/// directions share.
export async function contractorForStaff(clubId: string, staffUserId: string) {
  return prisma.contractor.findFirst({
    where: { clubId, convertedUserId: staffUserId, deletedAt: null },
    select: {
      id: true,
      name: true,
      w9Status: true,
      w9CurrentSubmissionId: true,
      taxIdLast4: true,
      taxIdKind: true,
      w9Url: true,
      w9RequestedAt: true,
      streetAddress: true,
      city: true,
      state: true,
      zipCode: true,
    },
  });
}
