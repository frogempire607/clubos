"use client";

// The error screen for every page outside the dashboard and the member portal
// (sign-in, sign-up, activation links, public event pages). Those had no error
// boundary at all, so a crash there was a blank white page — and, like every
// other crash, unrecorded. Same screen, and the same report, as the other two.
import RouteError from "@/components/RouteError";

export default function AppError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteError {...props} homeHref="/" homeLabel="Back to the start" />;
}
