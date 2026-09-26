"use client";

import { useSession } from "next-auth/react";
import StaffProfile from "@/components/staff/StaffProfile";
import { SkeletonCard } from "@/components/LoadingSkeleton";

// B21 — "My profile": the signed-in staff member's own profile. Deliberately
// outside /dashboard/staff so it needs no Staff & contractors permission —
// every staff member can always open their own profile.
export default function MyProfilePage() {
  const { data: session, status } = useSession();
  if (status !== "authenticated" || !session?.user?.id) {
    return (
      <div className="mx-auto max-w-[1192px] p-4 sm:px-8 sm:py-7">
        <SkeletonCard />
      </div>
    );
  }
  return <StaffProfile staffId={session.user.id} selfRoute />;
}
