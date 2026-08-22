import { NextResponse } from "next/server";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";

// Owner-editable auto-categorization rules for the Money Out matching UX.
//
//   GET  → every rule (active + inactive)
//   POST → create one
//
// Rules SUGGEST; nothing is auto-finalized. Owner still clicks to accept.

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "finances", "view");
  if (denied) return denied;

  const rules = await prisma.transactionCategoryRule.findMany({
    where: { clubId: session.user.clubId },
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json({ rules });
}

const RULE_TYPES = [
  "VENDOR_EXACT",
  "VENDOR_CONTAINS",
  "DESCRIPTION_CONTAINS",
  "AMOUNT_EQUALS",
  "AMOUNT_RANGE",
] as const;
const postSchema = z.object({
  matchType: z.enum(RULE_TYPES),
  matchValue: z.string().max(120).optional().nullable(),
  matchMin: z.number().optional().nullable(),
  matchMax: z.number().optional().nullable(),
  category: z.string().min(1).max(60),
  excludeFromTax: z.boolean().optional().default(false),
  markAsTransfer: z.boolean().optional().default(false),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "finances", "full");
  if (denied) return denied;

  let data: z.infer<typeof postSchema>;
  try {
    data = postSchema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
    throw err;
  }

  if (data.matchType === "AMOUNT_RANGE" && (data.matchMin == null || data.matchMax == null)) {
    return NextResponse.json({ error: "Amount range requires min and max." }, { status: 400 });
  }
  if (
    ["VENDOR_EXACT", "VENDOR_CONTAINS", "DESCRIPTION_CONTAINS", "AMOUNT_EQUALS"].includes(data.matchType) &&
    !data.matchValue
  ) {
    return NextResponse.json({ error: "Provide a match value for this rule type." }, { status: 400 });
  }

  const rule = await prisma.transactionCategoryRule.create({
    data: {
      clubId: session.user.clubId,
      matchType: data.matchType,
      matchValue: data.matchValue || null,
      matchMin: data.matchMin ?? null,
      matchMax: data.matchMax ?? null,
      category: data.category,
      excludeFromTax: data.excludeFromTax,
      markAsTransfer: data.markAsTransfer,
      createdByUserId: session.user.id ?? null,
    },
  });
  return NextResponse.json(rule, { status: 201 });
}
