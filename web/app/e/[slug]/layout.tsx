import type { Metadata } from "next";
import { parseLinkSegment } from "@/lib/eventShareLink";

// The public event page is a client component, so the head tags live here.
// A PRIVATE share link (/e/s-<token>) must never be indexed, and must not hand
// its address to the sites it links out to (directions, the host's
// registration page) in a Referer header. Public links are unchanged.
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  if (parseLinkSegment(slug).kind !== "token") return {};
  return {
    robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
    referrer: "no-referrer",
  };
}

export default function EventLinkLayout({ children }: { children: React.ReactNode }) {
  return children;
}
