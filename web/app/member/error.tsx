"use client";

import RouteError from "@/components/RouteError";

export default function MemberError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteError {...props} homeHref="/member" homeLabel="Back to home" />;
}
