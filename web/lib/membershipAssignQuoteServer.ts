// Assign membership — the database half of lib/membershipAssignQuote. The
// Assign sheet's live quote (GET …/membership/assign-quote) and every commit
// path (activate_card, enroll-paid, the offer link) call quoteAssignment, so
// the price shown is the price charged — and the commit re-derives it from
// the server's own data, never from a number the browser sent.

import { prisma } from "@/lib/prisma";
import { parseOptions, type MembershipOption } from "@/lib/membershipOptions";
import { discountedPrice } from "@/lib/discounts";
import { resolveStaffDiscount, type ResolvedStaffDiscount } from "@/lib/staffPayments";
import { siblingForNewMembership } from "@/lib/membershipSiblingServer";
import { composeAssignQuote, type AssignMethod, type AssignQuote } from "@/lib/membershipAssignQuote";

export type AssignQuoteResult =
  | {
      ok: true;
      quote: AssignQuote;
      /** The resolved typed code (valid), whether or not it won. */
      code: ResolvedStaffDiscount | null;
      plan: { id: string; name: string };
      option: MembershipOption;
    }
  | { ok: false; status: number; code: string; error: string };

export async function quoteAssignment(args: {
  clubId: string;
  memberId: string;
  membershipId: string;
  optionId: string;
  priceOverride: number | null;
  discountCode: string | null;
  applyFamily: boolean;
  method: AssignMethod;
}): Promise<AssignQuoteResult> {
  const [club, member, plan] = await Promise.all([
    prisma.club.findUnique({ where: { id: args.clubId }, select: { passProcessingFees: true } }),
    prisma.member.findFirst({
      where: { id: args.memberId, clubId: args.clubId, deletedAt: null },
      select: { id: true, firstName: true, lastName: true, userId: true, responsiblePayerUserId: true },
    }),
    prisma.membership.findFirst({ where: { id: args.membershipId, clubId: args.clubId, deletedAt: null }, select: { id: true, name: true, options: true } }),
  ]);
  if (!member) return { ok: false, status: 404, code: "NOT_FOUND", error: "Member not found." };
  if (!plan) return { ok: false, status: 404, code: "NO_PLAN", error: "That membership plan no longer exists." };
  const option = parseOptions(plan.options).find((o) => o.id === args.optionId);
  if (!option) return { ok: false, status: 404, code: "NO_OPTION", error: "That option is no longer on the plan. Re-pick it." };

  // The typed code: validated by the one staff-discount engine.
  let code: ResolvedStaffDiscount | null = null;
  let codeError: string | null = null;
  const raw = args.discountCode?.trim() || null;
  if (raw && args.priceOverride == null) {
    const r = await resolveStaffDiscount(args.clubId, raw, { type: "MEMBERSHIP", membershipId: plan.id });
    if (r.ok) code = r.discount;
    else codeError = r.error;
  }

  // The automatic discounts — the same function checkout, the portal and
  // Change plan use. Skipped under a typed price (it wins over everything).
  let autos: NonNullable<Awaited<ReturnType<typeof siblingForNewMembership>>["candidates"]> = [];
  let familyNote: string | null = null;
  if (args.priceOverride == null && option.price > 0 && option.billingPeriod !== "ONE_TIME") {
    const auto = await siblingForNewMembership({
      clubId: args.clubId, member, membershipId: plan.id, listPrice: option.price, billingPeriod: option.billingPeriod,
    });
    autos = auto.candidates ?? [];
    familyNote = auto.note ?? null;
  }

  const quote = composeAssignQuote({
    firstName: member.firstName,
    listPrice: option.price,
    billingPeriod: option.billingPeriod,
    override: args.priceOverride,
    applyFamily: args.applyFamily,
    autos,
    code,
    codeNet: code ? discountedPrice(option.price, code) : option.price,
    codeError,
    familyNote,
    method: args.method,
    passProcessingFees: !!club?.passProcessingFees,
  });
  return { ok: true, quote, code, plan: { id: plan.id, name: plan.name }, option };
}

/** A commit refuses when the price moved since the sheet showed it. */
export function priceMoved(expected: number | null | undefined, actual: number): boolean {
  return expected != null && Number.isFinite(expected) && Math.abs(expected - actual) > 0.005;
}
