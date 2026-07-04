"use client";

// My Bookings — kept as a deep-link route; the same content now lives in the
// Bookings tab on /member/schedule (design 2c / 1e). All list, check-in,
// chat, cancel and change-request behavior is in BookingsPanel.

import Link from "next/link";
import AthleteRail, { useAthleteProfiles } from "@/components/member/AthleteRail";
import BookingsPanel from "@/components/member/BookingsPanel";
import { GhostButton } from "@/components/member/ui";

export default function MemberBookingsPage() {
  const { profiles } = useAthleteProfiles();
  const hasRail = profiles.length >= 2;
  return (
    <div className={hasRail ? "md:grid md:grid-cols-[250px_minmax(0,1fr)] md:gap-6 md:items-start" : ""}>
      {hasRail && <AthleteRail />}
      <div className="min-w-0">
        <div className="mb-4 flex items-end justify-between gap-3">
          <div>
            <h1 className="text-[22px] md:text-[25px] font-extrabold tracking-[-0.01em] text-stone-900">Bookings</h1>
            <p className="text-sm text-stone-500 mt-0.5">
              Manage everything you&apos;ve booked — this also lives on{" "}
              <Link href="/member/schedule?tab=bookings" className="underline hover:text-stone-900">
                Schedule → Bookings
              </Link>
              .
            </p>
          </div>
          <GhostButton href="/member/privates" className="!px-3 !py-1.5 !text-xs flex-shrink-0 whitespace-nowrap">
            Request a private
          </GhostButton>
        </div>
        <BookingsPanel showContextNote />
      </div>
    </div>
  );
}
