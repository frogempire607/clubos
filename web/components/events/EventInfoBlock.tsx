// The top of an event, as a family reads it: picture, name, when (in the
// club's timezone), where (with directions), the whole description (never cut
// off, line breaks and links kept) and the event's own links.
//
// ONE component for the public event page (/e/[slug]) and the member event
// details screen (/member/events/[id]), so the two can't drift apart.

import type { ReactNode } from "react";
import { MapPin } from "lucide-react";
import EventLinks from "@/components/events/EventLinks";
import { eventWhen, linkifyText } from "@/lib/eventDetailsView";
import type { EventLink } from "@/lib/eventLinks";

export function DescriptionText({ text, className = "" }: { text: string | null | undefined; className?: string }) {
  const pieces = linkifyText(text);
  if (pieces.length === 0) return null;
  return (
    <p className={`whitespace-pre-wrap break-words leading-relaxed ${className}`}>
      {pieces.map((p, i) =>
        p.kind === "link" ? (
          <a key={i} href={p.href} target="_blank" rel="noopener noreferrer" className="underline break-all">
            {p.text}
          </a>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </p>
  );
}

export default function EventInfoBlock({
  name,
  badge,
  imageUrl,
  imagePositionX,
  imagePositionY,
  startsAt,
  endsAt,
  timeZone,
  location,
  description,
  links,
  accent,
}: {
  name: string;
  /** The event's type, or the public page's tournament chip. */
  badge?: ReactNode;
  imageUrl?: string | null;
  imagePositionX?: number | null;
  imagePositionY?: number | null;
  startsAt: string | Date;
  endsAt: string | Date;
  timeZone?: string | null;
  location?: { name: string; address?: string | null; mapUrl?: string | null } | null;
  description?: string | null;
  links?: EventLink[] | null;
  accent?: string | null;
}) {
  const when = eventWhen(startsAt, endsAt, timeZone);
  return (
    <>
      {imageUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={imageUrl}
          alt=""
          className="w-full aspect-[16/9] object-cover rounded-xl border border-stone-200 mb-4"
          style={{ objectPosition: `${imagePositionX ?? 50}% ${imagePositionY ?? 50}%` }}
        />
      )}
      <div className="bg-white rounded-xl border border-stone-200 p-5 sm:p-6 mb-4">
        {badge && <div className="flex items-center gap-2 mb-1 flex-wrap">{badge}</div>}
        <h1 className="text-2xl font-semibold text-stone-900 break-words">{name}</h1>
        <p className="text-sm text-stone-700 mt-1">{when.date}</p>
        <p className="text-sm text-stone-500">{when.time}</p>
        {location && (
          <p className="text-sm text-stone-500 mt-1 flex items-start gap-1">
            <MapPin className="h-4 w-4 mt-0.5 shrink-0" strokeWidth={2} aria-hidden />
            <span>
              {location.name}
              {location.address ? ` · ${location.address}` : ""}
              {location.mapUrl && (
                <>
                  {" · "}
                  <a href={location.mapUrl} target="_blank" rel="noopener noreferrer" className="underline" style={{ color: accent ?? undefined }}>
                    Directions
                  </a>
                </>
              )}
            </span>
          </p>
        )}
        {description && <DescriptionText text={description} className="text-sm text-stone-700 mt-3" />}
        <EventLinks links={links} className="mt-4" />
      </div>
    </>
  );
}
