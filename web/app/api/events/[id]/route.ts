import { NextResponse } from "next/server";
import { applyExclusions, resolveEventWrite } from "@/lib/eventPricingModel";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import {
  planReprice,
  pricingChanged,
  pricingLockReason,
  variableCostTurnedOff,
} from "@/lib/eventRepricing";

const sessionSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional().nullable(),
  startsAt: z.string(),
  endsAt: z.string(),
  sortOrder: z.number().int().default(0),
  // B11 slice 2 — per-session price; null = not sold on its own.
  price: z.number().min(0).optional().nullable(),
});

const formFieldSchema = z.object({
  id: z.string(),
  label: z.string().min(1),
  type: z.enum(["text", "email", "phone", "textarea", "select", "checkbox"]),
  required: z.boolean().default(false),
  options: z.array(z.string()).optional(),
});

const updateSchema = z.object({
  type: z.enum(["CLASS", "PRIVATE", "CLINIC", "CAMP", "TOURNAMENT", "OTHER"]).optional(),
  customEventTypeId: z.string().optional().nullable(),
  name: z.string().min(1).optional(),
  description: z.string().optional().nullable(),
  startsAt: z.string().optional(),
  endsAt: z.string().optional(),
  capacity: z.number().int().positive().optional().nullable(),
  memberPrice: z.number().min(0).optional().nullable(),
  nonMemberPrice: z.number().min(0).optional().nullable(),
  dropInFee: z.number().min(0).optional().nullable(),
  // B11 slice 2 — see app/api/events/route.ts. Optional; both vocabularies
  // are written on every save.
  pricingModel: z.enum(["FREE", "FIXED", "SPLIT"]).optional().nullable(),
  signupAccess: z.enum(["MEMBERS", "PUBLIC_LINK", "STAFF_ONLY"]).optional().nullable(),
  splitInvoiceWhen: z.enum(["AFTER_EVENT", "ON_DATE"]).optional().nullable(),
  sellIndividualSessions: z.boolean().optional().nullable(),
  travelFee: z.number().min(0).optional().nullable(),
  publishAt: z.string().optional().nullable(),
  unpublishAt: z.string().optional().nullable(),
  locationId: z.string().optional().nullable(),
  visibility: z.enum(["PUBLIC", "MEMBERS_ONLY", "STAFF_ONLY"]).optional(),
  purchaseAccess: z.enum(["ANYONE", "STAFF_ONLY"]).optional(),
  allowMembershipPayment: z.boolean().optional(),
  imageUrl: z.string().optional().nullable(),
  imagePositionX: z.number().min(0).max(100).optional(),
  imagePositionY: z.number().min(0).max(100).optional(),
  pricingOptions: z.array(z.object({ type: z.literal("membership"), membershipId: z.string() })).optional(),
  staffUserIds: z.array(z.string()).optional(),
  sessions: z.array(sessionSchema).optional(),
  tournamentMode: z.enum(["HOST", "ATTEND"]).optional().nullable(),
  registrationForm: z.array(formFieldSchema).optional().nullable(),
  publicRegistration: z.boolean().optional(),
  publicFormIntro: z.string().optional().nullable(),
  publicPricingOption: z.enum(["MEMBER", "NON_MEMBER", "DROP_IN"]).optional().nullable(),
  variableCostEnabled: z.boolean().optional(),
  variableCostMode: z.enum(["ESTIMATED", "OFFICIAL"]).optional().nullable(),
  variableCostTotal: z.number().min(0).optional().nullable(),
  variableCostEstimatedSignups: z.number().int().positive().optional().nullable(),
  variableCostEstimatedTotal: z.number().min(0).optional().nullable(),
  invoiceScheduledAt: z.string().optional().nullable(),
  paymentMethods: z.array(z.enum(["CARD", "AUTO_CARD", "CASH", "CHECK"])).optional().nullable(),
  autoChargeDate: z.string().optional().nullable(),
  requirePaymentBeforeCheckin: z.boolean().optional(),

  // ── Phase 5 §5.3.2 — coach approval + payment, per event ─────────────────
  // Every nullable flag is tri-state on the wire: true = on for this event,
  // false = explicitly off, null = inherit the event type's defaultPolicy.
  // Collapsing null and false would make a type-wide default impossible to
  // override, so the schema keeps them distinct all the way to the column.
  requiresCoachApproval: z.boolean().nullable().optional(),
  approvalPaymentIntent: z
    .enum(["CARD", "APPROVAL_CHARGE", "INVOICE", "CASH_CHECK", "PARENT_CHOOSES"])
    .nullable()
    .optional(),
  allowProposedChanges: z.boolean().nullable().optional(),
  responsibleCoachUserId: z.string().nullable().optional(),
  holdSpotDuringReview: z.boolean().optional(),
  cancellationPolicyText: z.string().max(2000).nullable().optional(),
  paymentDueBy: z.string().nullable().optional(),
  escalationEnabled: z.boolean().nullable().optional(),
  escalationAnchor: z.enum(["registrationDeadline", "eventStart", "autoChargeDate"]).nullable().optional(),
  escalationSchedule: z.enum(["DEFAULT_TOURNAMENT", "GENTLE", "AGGRESSIVE", "CUSTOM"]).nullable().optional(),
  escalationCustomDays: z.array(z.number().int()).nullable().optional(),
});

function slugify(name: string): string {
  return (
    name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) ||
    "event"
  );
}

async function requireEvent(id: string, clubId: string) {
  return prisma.event.findFirst({
    where: { id, clubId, deletedAt: null },
    // Sessions ride along: the PATCH merges the money/access model over the
    // stored event and keeps session ids stable (slice 2).
    include: { sessions: { orderBy: { sortOrder: "asc" } } },
  });
}

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const event = await prisma.event.findFirst({
    where: { id: params.id, clubId: session.user.clubId, deletedAt: null },
    include: {
      location: true,
      customEventType: true,
      sessions: { orderBy: { sortOrder: "asc" } },
      staffAssignments: { include: { user: { select: { id: true, firstName: true, lastName: true } } } },
      bookings: {
        include: { member: { select: { id: true, firstName: true, lastName: true } } },
        orderBy: { createdAt: "asc" },
      },
      registrations: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!event) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(event);
}

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const event = await requireEvent(params.id, session.user.clubId);
  if (!event) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const body = await req.json();
    const { sessions, staffUserIds, ...rest } = updateSchema.parse(body);

    const baseType =
      "customEventTypeId" in rest
        ? rest.customEventTypeId
          ? "OTHER"
          : rest.type
        : rest.type;

    const isTournament = (baseType ?? event.type) === "TOURNAMENT";

    // Ensure a public slug exists once public registration is turned on (or it
    // becomes a hosted tournament). Never change an existing slug — links shared
    // with non-members must keep working.
    // ── Money + access, both vocabularies (slice 2) ──────────────────────
    // A PATCH is partial, so the resolution runs on the MERGED event (what was
    // sent over what is stored) and only when something money/access-shaped
    // was sent at all. The new vocabulary, when present, is the source.
    const MODEL_KEYS = [
      "pricingModel", "signupAccess", "splitInvoiceWhen", "sellIndividualSessions",
      "memberPrice", "nonMemberPrice", "dropInFee", "variableCostEnabled",
      "visibility", "purchaseAccess", "publicRegistration", "invoiceScheduledAt",
    ] as const;
    const touchesModel = MODEL_KEYS.some((k) => k in rest) || sessions !== undefined;
    const model = touchesModel
      ? resolveEventWrite({
          pricingModel: rest.pricingModel ?? (rest.pricingModel === undefined && !("variableCostEnabled" in rest) && !("dropInFee" in rest) && !("memberPrice" in rest) && !("nonMemberPrice" in rest) && !("visibility" in rest) && !("purchaseAccess" in rest) && !("publicRegistration" in rest)
              ? (event.pricingModel as "FREE" | "FIXED" | "SPLIT")
              : null),
          signupAccess: rest.signupAccess ?? (rest.pricingModel ? (event.signupAccess as "MEMBERS" | "PUBLIC_LINK" | "STAFF_ONLY") : null),
          splitInvoiceWhen: rest.splitInvoiceWhen ?? (event.splitInvoiceWhen as "AFTER_EVENT" | "ON_DATE" | null),
          sellIndividualSessions: rest.sellIndividualSessions ?? event.sellIndividualSessions,
          sessionPrices: sessions ? sessions.map((x) => x.price ?? null) : event.sessions.map((x) => (x.price == null ? null : Number(x.price))),
          memberPrice: "memberPrice" in rest ? rest.memberPrice ?? null : event.memberPrice == null ? null : Number(event.memberPrice),
          nonMemberPrice: "nonMemberPrice" in rest ? rest.nonMemberPrice ?? null : event.nonMemberPrice == null ? null : Number(event.nonMemberPrice),
          dropInFee: "dropInFee" in rest ? rest.dropInFee ?? null : event.dropInFee == null ? null : Number(event.dropInFee),
          variableCostEnabled: rest.variableCostEnabled ?? event.variableCostEnabled,
          visibility: rest.visibility ?? event.visibility,
          purchaseAccess: rest.purchaseAccess ?? event.purchaseAccess,
          publicRegistration: rest.publicRegistration ?? event.publicRegistration,
          invoiceScheduledAt: rest.invoiceScheduledAt
            ? new Date(rest.invoiceScheduledAt)
            : rest.invoiceScheduledAt === null
              ? null
              : event.invoiceScheduledAt,
        })
      : null;

    const willBePublic =
      (model ? model.publicRegistration : rest.publicRegistration === true) ||
      (isTournament && (rest.tournamentMode ?? event.tournamentMode) === "HOST");
    let publicSlug = event.publicSlug;
    if (willBePublic && !publicSlug) {
      const base = slugify(rest.name ?? event.name);
      let candidate = base;
      let n = 1;
      while (n < 50) {
        const clash = await prisma.event.findUnique({
          where: { publicSlug: candidate },
          select: { id: true },
        });
        if (!clash) break;
        candidate = `${base}-${n++}`;
      }
      publicSlug = candidate;
    }

    const {
      paymentDueBy, responsibleCoachUserId, escalationCustomDays, registrationForm, variableCostEnabled, variableCostMode,
      variableCostTotal, variableCostEstimatedSignups, variableCostEstimatedTotal, tournamentMode, paymentMethods, autoChargeDate,
      // Written from `model` below, never straight from the body.
      pricingModel: _pm, signupAccess: _sa, splitInvoiceWhen: _siw, sellIndividualSessions: _sis,
      memberPrice: _mp, nonMemberPrice: _nmp, dropInFee: _dif, visibility: _vis, purchaseAccess: _pa, publicRegistration: _pr,
      invoiceScheduledAt: _isa,
      ...flatRest
    } = rest;
    void _pm; void _sa; void _siw; void _sis; void _mp; void _nmp; void _dif; void _vis; void _pa; void _pr; void _isa;
    const modelWrite = model
      ? {
          pricingModel: model.pricingModel,
          signupAccess: model.signupAccess,
          splitInvoiceWhen: model.splitInvoiceWhen,
          sellIndividualSessions: model.sellIndividualSessions,
          memberPrice: model.memberPrice,
          nonMemberPrice: model.nonMemberPrice,
          dropInFee: model.dropInFee,
          variableCostEnabled: model.variableCostEnabled,
          visibility: model.visibility,
          purchaseAccess: model.purchaseAccess,
          publicRegistration: model.publicRegistration,
          invoiceScheduledAt: model.invoiceScheduledAt,
        }
      : {};
    const effectiveMethods = paymentMethods === undefined ? undefined : paymentMethods;
    const exclusions = model && effectiveMethods
      ? applyExclusions({
          pricingModel: model.pricingModel,
          signupAccess: model.signupAccess,
          paymentMethods: effectiveMethods,
          chargeOnApproval: (rest.approvalPaymentIntent ?? event.approvalPaymentIntent) === "APPROVAL_CHARGE",
          requiresCoachApproval: !!(rest.requiresCoachApproval ?? event.requiresCoachApproval),
        }).paymentMethods
      : effectiveMethods;

    const updated = await prisma.event.update({
      where: { id: params.id },
      data: {
        ...flatRest,
        ...modelWrite,
        ...(baseType ? { type: baseType } : {}),
        ...(registrationForm !== undefined ? { registrationForm: registrationForm ?? undefined } : {}),
        ...(tournamentMode !== undefined ? { tournamentMode: isTournament ? tournamentMode : null } : {}),
        ...(variableCostEnabled !== undefined && !model ? { variableCostEnabled } : {}),
        ...(variableCostMode !== undefined ? { variableCostMode } : {}),
        ...(variableCostTotal !== undefined ? { variableCostTotal } : {}),
        ...(variableCostEstimatedSignups !== undefined ? { variableCostEstimatedSignups } : {}),
        ...(variableCostEstimatedTotal !== undefined ? { variableCostEstimatedTotal } : {}),
        ...(isTournament ? {} : { isTournament: false }),
        ...(isTournament ? { isTournament: true } : {}),
        publicSlug,
        startsAt: rest.startsAt ? new Date(rest.startsAt) : undefined,
        endsAt: rest.endsAt ? new Date(rest.endsAt) : undefined,
        publishAt: rest.publishAt ? new Date(rest.publishAt) : rest.publishAt === null ? null : undefined,
        unpublishAt: rest.unpublishAt ? new Date(rest.unpublishAt) : rest.unpublishAt === null ? null : undefined,
        ...(model
          ? {}
          : {
              invoiceScheduledAt: rest.invoiceScheduledAt
                ? new Date(rest.invoiceScheduledAt)
                : rest.invoiceScheduledAt === null
                  ? null
                  : undefined,
            }),
        // An explicit null means "revert to the default (card only)" — it must
        // clear the column, not be dropped as a no-op.
        ...(exclusions !== undefined
          ? { paymentMethods: exclusions === null ? Prisma.DbNull : exclusions }
          : {}),
        autoChargeDate: autoChargeDate
          ? new Date(autoChargeDate)
          : autoChargeDate === null
            ? null
            : undefined,
        paymentDueBy: paymentDueBy
          ? new Date(paymentDueBy)
          : paymentDueBy === null
            ? null
            : undefined,
        // Soft pointer, no FK — an empty picker means "any staff with
        // events:edit can approve", which is a real setting, not an absence.
        ...(responsibleCoachUserId !== undefined
          ? { responsibleCoachUserId: responsibleCoachUserId || null }
          : {}),
        // Json column: an explicit null must CLEAR it (the owner switched off
        // a custom cadence), not be dropped as a no-op.
        ...(escalationCustomDays !== undefined
          ? {
              escalationCustomDays:
                escalationCustomDays === null
                  ? Prisma.DbNull
                  : (escalationCustomDays as Prisma.InputJsonValue),
            }
          : {}),
      },
    });

    if (sessions !== undefined) {
      // Slice 2: sessions keep their ids. The old delete-and-recreate minted new
      // ids on every save, which is harmless until a registration points at a
      // session (sessionIds) — then every edit would orphan every per-session
      // purchase. Now: update by id, create the new ones, delete the missing
      // ones — and refuse to delete a session someone has paid for.
      const keepIds = sessions.map((x) => x.id).filter((x): x is string => !!x);
      const referenced = await prisma.eventRegistration.findMany({
        where: { eventId: params.id, status: { not: "CANCELED" }, NOT: { sessionIds: { isEmpty: true } } },
        select: { sessionIds: true },
      });
      const referencedIds = new Set(referenced.flatMap((r) => r.sessionIds));
      const blocked = event.sessions.filter((x) => !keepIds.includes(x.id) && referencedIds.has(x.id));
      if (blocked.length > 0) {
        return NextResponse.json(
          {
            error: `${blocked.length === 1 ? "A session" : `${blocked.length} sessions`} you removed ${blocked.length === 1 ? "has" : "have"} paid registrations attached. Cancel or move those registrations first — nothing was saved.`,
            code: "SESSION_HAS_REGISTRATIONS",
            sessionIds: blocked.map((x) => x.id),
          },
          { status: 409 },
        );
      }
      const sellsSessions = model ? model.sellIndividualSessions : event.sellIndividualSessions;
      await prisma.eventSession.deleteMany({ where: { eventId: params.id, id: { notIn: keepIds } } });
      for (const [i, s] of sessions.entries()) {
        const data = {
          name: s.name || null,
          startsAt: new Date(s.startsAt),
          endsAt: new Date(s.endsAt),
          sortOrder: s.sortOrder ?? i,
          price: sellsSessions ? s.price ?? null : null,
        };
        if (s.id && event.sessions.some((x) => x.id === s.id)) {
          await prisma.eventSession.update({ where: { id: s.id }, data });
        } else {
          await prisma.eventSession.create({ data: { ...data, eventId: params.id } });
        }
      }
    }

    if (staffUserIds !== undefined) {
      await prisma.eventStaffAssignment.deleteMany({ where: { eventId: params.id, clubId: session.user.clubId } });
      if (staffUserIds.length > 0) {
        await prisma.eventStaffAssignment.createMany({
          data: staffUserIds.map((userId) => ({
            clubId: session.user.clubId,
            eventId: params.id,
            userId,
            role: "COACH",
          })),
          skipDuplicates: true,
        });
      }
    }

    // ── Pricing edits must not leave stale per-registration amounts behind ──
    // Editing an event used to touch event columns ONLY, so registrations kept
    // whatever amountDue they were created with. That is the Frog Empire Road
    // Trip bug: a camp switched from a variable-cost split to a flat $450 went
    // on invoicing $533.33 per family.
    let repricing: ReturnType<typeof planReprice> | null = null;
    let cleared = 0;
    if (pricingChanged(event, updated)) {
      const registrations = await prisma.eventRegistration.findMany({
        where: { eventId: params.id, status: { not: "CANCELED" } },
        orderBy: { createdAt: "asc" },
      });

      // Variable cost turned OFF: every non-committed amountDue is a per-head
      // share of a total that no longer exists. Clearing it (rather than
      // writing the new price over it) makes the event's own price the single
      // source of truth again, and is the one transition safe to do without
      // asking — the old number is provably orphaned.
      if (variableCostTurnedOff(event, updated)) {
        const now = new Date();
        const clearable = registrations
          .filter((r) => !pricingLockReason(r, now) && r.amountDue != null)
          .map((r) => r.id);
        if (clearable.length > 0) {
          const res = await prisma.eventRegistration.updateMany({
            where: { id: { in: clearable }, clubId: session.user.clubId },
            data: { amountDue: null },
          });
          cleared = res.count;
          for (const r of registrations) {
            if (clearable.includes(r.id)) r.amountDue = null;
          }
        }
      }

      // Everything else (estimate adjusted, flat price changed, pricing option
      // switched) is handed back as a PREVIEW. It is not applied silently:
      // a fixed-price amountDue can legitimately differ per registrant
      // (member vs non-member, staff discount), so overwriting it is the
      // owner's call — POST /api/events/[id]/reprice-registrations.
      repricing = planReprice(updated, registrations);
    }

    return NextResponse.json({ ...updated, repricing, amountsCleared: cleared });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors }, { status: 400 });
    }
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}

export async function DELETE(_: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Staff with full Events access can delete — not owner-only.
  const denied = requirePermission(session, "events", "full");
  if (denied) return denied;

  const event = await requireEvent(params.id, session.user.clubId);
  if (!event) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.event.update({
    where: { id: params.id },
    data: { deletedAt: new Date() },
  });

  return NextResponse.json({ ok: true });
}
