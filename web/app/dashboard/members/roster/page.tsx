// Phase 4.5.2 — the redesigned members list.
//
// ── Why this is a separate route for now ─────────────────────────────────────
// The existing /dashboard/members page is ~2,400 lines and owns the Add-member
// modal, the CSV import mapping, the custom-field editor and the membership
// purchase flow. Swapping the roster underneath all of that in one commit would
// put every one of those flows at risk in the same change.
//
// So the new list ships here, complete and usable, and the cutover — porting
// the modals across and pointing /dashboard/members at this — is its own step.
// See PROGRESS.md 4.5.2 for what the cutover still needs.

import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { authOptions } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import MembersTabs from "@/components/MembersTabs";
import MembersRoster from "@/components/members/MembersRoster";
import { SkeletonList } from "@/components/LoadingSkeleton";

export const dynamic = "force-dynamic";

export default async function RosterPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/login");

  // Resolved server-side so the client never decides its own permissions.
  // J-5: anything that starts a charge is gated on `billing`, never on
  // `members` — a coach with members:edit must not be able to begin billing a
  // family. Owners bypass everything, as everywhere else.
  const isOwner = session.user.role === "OWNER";
  // Same cast as lib/apiGuard.ts:29 — the NextAuth Session type doesn't declare
  // `permissions`, but the JWT carries it and every guard in the repo reads it
  // this way. Typing it properly means a next-auth.d.ts augmentation, which is
  // pre-existing debt tracked in CLAUDE.md.
  const perms = (session.user as unknown as { permissions?: Record<string, unknown> | null }).permissions;
  const canEdit = isOwner || hasPermission(perms, "members", "edit");
  const canBill = isOwner || hasPermission(perms, "billing", "full");

  return (
    <>
      <MembersTabs />
      <Suspense fallback={<div className="p-6"><SkeletonList rows={8} /></div>}>
        <MembersRoster canEdit={canEdit} canBill={canBill} />
      </Suspense>
    </>
  );
}
