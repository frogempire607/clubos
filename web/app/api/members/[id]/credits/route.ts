import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  normalizePricingMode,
  packageLessonTypeIds,
  packageTotalForBasePrice,
} from "@/lib/privateLessonRules";

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const member = await prisma.member.findFirst({
    where: { id: params.id, clubId: session.user.clubId, deletedAt: null },
  });
  if (!member) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const ledger = await prisma.privateCreditLedger.findMany({
    where: { memberId: params.id, clubId: session.user.clubId },
    include: { package: { select: { title: true } } },
    orderBy: { createdAt: "desc" },
  });

  const totalRemaining = ledger
    .filter((l) => l.status === "active")
    .reduce((sum, l) => sum + (l.creditsGranted - l.creditsUsed), 0);

  return NextResponse.json({ ledger, totalRemaining });
}

const adjustSchema = z.object({
  creditsGranted: z.number().int().positive().optional(),
  packageId: z.string().optional().nullable(),
  expiresAfterDays: z.number().int().positive().optional().nullable(),
  notes: z.string().optional(),
  lessonTypeId: z.string().optional().nullable(),
  // For PERCENT/FIXED packages: the chosen lesson type + tier price option so
  // the total can be computed against the right tier (e.g. coach $80 vs $60).
  priceOptionId: z.string().optional().nullable(),
});

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const member = await prisma.member.findFirst({
    where: { id: params.id, clubId: session.user.clubId, deletedAt: null },
  });
  if (!member) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const data = adjustSchema.parse(await req.json());
    const pkg = data.packageId
      ? await prisma.privatePackage.findFirst({
          where: { id: data.packageId, clubId: session.user.clubId, deletedAt: null, active: true },
        })
      : null;

    if (data.packageId && !pkg) {
      return NextResponse.json({ error: "Package not found" }, { status: 404 });
    }

    const lessonsGranted = pkg ? pkg.credits + pkg.bonusCredits : data.creditsGranted;
    if (!lessonsGranted) {
      return NextResponse.json({ error: "Lesson quantity is required." }, { status: 400 });
    }

    const expiresAfterDays = data.expiresAfterDays ?? pkg?.expiresAfterDays ?? null;
    const expiresAt = expiresAfterDays
      ? new Date(Date.now() + expiresAfterDays * 86400000)
      : null;

    // Resolve the actual price for this purchase. PERCENT/FIXED packages need
    // the chosen lesson type + tier to know the base per-lesson price.
    let computedPricePaid: number | null = pkg ? Number(pkg.price) : null;
    let computedLessonTypeId: string | null = data.lessonTypeId ?? null;
    if (pkg) {
      const pkgIds = packageLessonTypeIds(pkg.lessonTypeIds, pkg.lessonTypeId);
      if (pkgIds.length === 1 && !computedLessonTypeId) computedLessonTypeId = pkgIds[0];

      const mode = normalizePricingMode(pkg.pricingMode);
      if (mode !== "FLAT") {
        const chosenTypeId = data.lessonTypeId ?? (pkgIds.length === 1 ? pkgIds[0] : null);
        if (!chosenTypeId) {
          return NextResponse.json(
            { error: "Pick a lesson type for this discount package." },
            { status: 400 },
          );
        }
        if (pkgIds.length && !pkgIds.includes(chosenTypeId)) {
          return NextResponse.json(
            { error: "That lesson type isn't covered by this package." },
            { status: 400 },
          );
        }
        const lessonType = await prisma.privateLessonType.findFirst({
          where: { id: chosenTypeId, clubId: session.user.clubId, deletedAt: null },
        });
        if (!lessonType) {
          return NextResponse.json({ error: "Lesson type not found" }, { status: 404 });
        }
        type Opt = { id: string; label: string; price: number; coachIds: string[] };
        const opts = Array.isArray(lessonType.priceOptions)
          ? (lessonType.priceOptions as unknown as Opt[])
          : [];
        let basePerLesson = Number(lessonType.basePrice);
        if (data.priceOptionId) {
          const chosen = opts.find((o) => o.id === data.priceOptionId);
          if (!chosen) {
            return NextResponse.json({ error: "That pricing option is no longer available." }, { status: 400 });
          }
          basePerLesson = Number(chosen.price);
        } else if (opts.length) {
          // Multi-tier lesson type but no option chosen: use the lowest tier so
          // a missing pick doesn't accidentally over-charge. Owner can always
          // adjust later.
          basePerLesson = Math.min(...opts.map((o) => Number(o.price)));
        }
        computedPricePaid = packageTotalForBasePrice(
          {
            pricingMode: pkg.pricingMode,
            discountValue: pkg.discountValue ? Number(pkg.discountValue) : 0,
            price: Number(pkg.price),
            credits: pkg.credits,
            bonusCredits: pkg.bonusCredits,
          },
          basePerLesson,
        );
        computedLessonTypeId = chosenTypeId;
      }
    }

    const entry = await prisma.privateCreditLedger.create({
      data: {
        clubId: session.user.clubId,
        memberId: params.id,
        packageId: pkg?.id ?? null,
        lessonTypeId: computedLessonTypeId,
        creditsGranted: lessonsGranted,
        purchaseType: pkg ? "PACKAGE" : "MANUAL",
        expiresAt,
        pricePaid: computedPricePaid,
        notes: data.notes || (pkg ? `Package purchase: ${pkg.title}` : null),
        adjustedById: session.user.id,
      },
    });
    return NextResponse.json(entry, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
