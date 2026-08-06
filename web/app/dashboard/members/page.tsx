// The members list.
//
// ── The cutover (Phase 4.5.2, session 3) ─────────────────────────────────────
// Session 2 shipped the redesigned roster at /dashboard/members/roster and left
// this route on the old 2,400-line client page, because that page also owned
// the Add-member modal, CSV import, the membership purchase flow and the two
// bulk composers. Julian's verdict on the result was short: "One route, one
// list. Don't leave two."
//
// So the modals moved to components/members/MemberModals.tsx (bodies unchanged),
// the roster took ownership of them, and this route is now the roster. There is
// no second list. /dashboard/members/roster redirects here so existing links and
// bookmarks still land somewhere real.

import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { authOptions } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import MembersTabs from "@/components/MembersTabs";
import MembersRoster from "@/components/members/MembersRoster";
import { SkeletonList } from "@/components/LoadingSkeleton";

export const dynamic = "force-dynamic";

export default async function MembersPage() {
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

  // The password-reset dialog promises "Sent as <staff> and recorded" — that
  // name has to be the real signed-in staffer, not a placeholder.
  const staffName = session.user.name || session.user.email || "you";

  return (
    <>
      <MembersTabs />
      <Suspense fallback={<div className="p-6"><SkeletonList rows={8} /></div>}>
        <MembersRoster canEdit={canEdit} canBill={canBill} isOwner={isOwner} staffName={staffName} />
      </Suspense>
    </>
  );
}
