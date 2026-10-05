// Labeled external links on an event, as buttons that open in a new tab.
//
// One component for every surface (public page, member portal, confirmation
// card, staff detail) so the links look and behave the same everywhere.
//
// Opening: a plain <a target="_blank" rel="noopener noreferrer">, which is how
// every other outside link in the app opens (club website, directions). In the
// native shell the WebView only navigates to the app's own hosts
// (capacitor.config.ts allowNavigation), so an outside address is handed to the
// phone's browser rather than replacing the app.
//
// Addresses are run through lib/eventLinks once more here: nothing that isn't a
// plain http(s) address can reach an href, whatever the caller passed.

import { ExternalLink } from "lucide-react";
import { normalizeEventLinks, type EventLink } from "@/lib/eventLinks";

export default function EventLinks({
  links,
  heading = "Links",
  tone = "family",
  compact = false,
  className = "",
}: {
  links: EventLink[] | null | undefined;
  /** Small label above the buttons; pass null to leave it out. */
  heading?: string | null;
  /** "family" = the stone palette of the public/member pages; "staff" = dashboard tokens. */
  tone?: "family" | "staff";
  /** Tighter buttons on wide screens (still 44px tall on phones). */
  compact?: boolean;
  className?: string;
}) {
  const safe = normalizeEventLinks(links);
  if (safe.length === 0) return null;
  const btn =
    tone === "staff"
      ? "border-app-border bg-surface text-text-primary hover:bg-app-bg"
      : "border-stone-300 bg-white text-stone-800 hover:bg-stone-50";
  const headingCls = tone === "staff" ? "text-text-muted" : "text-stone-500";
  const iconCls = tone === "staff" ? "text-text-muted" : "text-stone-400";
  return (
    <div className={className}>
      {heading && <p className={`text-xs font-medium mb-1.5 ${headingCls}`}>{heading}</p>}
      <ul className="flex flex-wrap gap-2">
        {safe.map((l) => (
          <li key={l.url} className="max-w-full">
            <a
              href={l.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              aria-label={`${l.label} (opens in a new tab)`}
              className={`inline-flex items-center gap-2 max-w-full min-h-[44px] ${compact ? "md:min-h-[36px]" : ""} px-3.5 py-2 rounded-lg border text-sm font-medium ${btn}`}
            >
              <span className="truncate">{l.label}</span>
              <ExternalLink size={14} strokeWidth={2} className={`flex-shrink-0 ${iconCls}`} aria-hidden="true" />
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
