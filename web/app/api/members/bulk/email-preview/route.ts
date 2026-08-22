// POST /api/members/bulk/email-preview
//
// Called by the Members page BEFORE the composer opens. Given the selected
// member IDs and the sender's chosen household mode, returns the exact
// pre-send review that plan §3A demands:
//
//   - number of selected profiles
//   - number of unique email addresses
//   - number of EmailSend rows that WILL be inserted
//   - counts + row-level detail for skipped recipients (no-email, opt-out,
//     invalid, duplicate-in-batch)
//   - per-recipient preview: which address the send is going to + the
//     display name (guardian's name when routing to a guardian).
//
// This endpoint does NOT touch the DB (no EmailSend inserts, no side effects)
// — it's a read-only preview. The actual send is /api/members/bulk with
// action='email' (checkpoint C follow-up in this same file's sibling).
//
// Auth: same tier as /api/members/bulk — OWNER or STAFF with messages
// permission (view is enough for the preview; the send itself will require
// send / bulk). We don't tier-gate here so the modal can render the counts
// even for Growth clubs; the actual send route is where the tier gate
// (emailSms feature flag) fires.

import { NextResponse } from "next/server";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requirePermission } from "@/lib/apiGuard";
import { resolveRecipients, type HouseholdMode } from "@/lib/emailRecipients";
import { filterMemberIdsByCoachAudience } from "@/lib/coachAudience";

const MAX_IDS = 5000;

const schema = z.object({
  memberIds: z.array(z.string().min(1)).min(1).max(MAX_IDS),
  mode: z.enum([
    "HOUSEHOLD",
    "PER_MEMBER",
    "PER_ATHLETE_PRIMARY",
    "ATHLETE_ONLY",
    "PRIMARY_GUARDIAN",
    "ALL_GUARDIANS",
    "PAYER",
    "ACCOUNT_HOLDER",
  ]).default("HOUSEHOLD"),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // messages:view is enough to see the preview; the send itself needs send.
  const denied = requirePermission(session, "messages", "view");
  if (denied) return denied;

  let data: z.infer<typeof schema>;
  try {
    data = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  // 3L coach-audience — filter the requested ids to what THIS caller may
  // address before we build the recipient set. Owner / audience_all_club
  // returns the input unchanged; a coach without that sub-scope sees
  // only the members enrolled in classes/events they teach.
  const audienceFilter = await filterMemberIdsByCoachAudience(
    {
      role: (session.user as { role?: string }).role,
      userId: session.user.id,
      clubId: session.user.clubId,
      permissions: (session.user as { permissions?: Record<string, unknown> | null }).permissions ?? null,
    },
    data.memberIds,
  );

  const resolution = await resolveRecipients({
    clubId: session.user.clubId,
    memberIds: audienceFilter.allowed,
    mode: data.mode as HouseholdMode,
    // MARKETING semantics — the preview must reflect the same opt-out rules
    // the send will apply so the count on the confirmation button matches
    // the count on the receipt.
    respectMarketingOptOut: true,
  });

  return NextResponse.json({
    mode: data.mode,
    counts: {
      ...resolution.counts,
      // Show the drop-count so the UI can render "N members hidden — you
      // only teach some of the selected members".
      outsideCoachAudience: audienceFilter.dropped.length,
    },
    // Cap the per-row detail to prevent a 5000-selection payload from
    // becoming a 500KB response. The UI shows first N rows + "N more".
    preview: resolution.send.slice(0, 200).map((r) => ({
      memberId: r.memberId,
      memberName: `${r.memberFirstName} ${r.memberLastName}`.trim(),
      isMinor: r.isMinor,
      recipientEmail: r.recipientEmail,
      recipientDisplayName: r.recipientDisplayName,
    })),
    skipped: resolution.skipped.slice(0, 200).map((s) => ({
      memberId: s.memberId,
      memberName: `${s.memberFirstName} ${s.memberLastName}`.trim(),
      reason: s.reason,
      attemptedEmail: s.attemptedEmail,
    })),
    truncated: {
      preview: resolution.send.length > 200,
      skipped: resolution.skipped.length > 200,
    },
  });
}
