import { loadRegistrationPage } from "@/lib/registrationPage";

// GET /r/[id]/calendar.ics — the "Add to calendar" the card offers.
//
// STATUS is the point: a registration still waiting on a coach emits
// TENTATIVE, which is what iCal has for "pencilled in". A calendar entry that
// claims CONFIRMED for a spot nobody has approved is the same lie as a page
// that says "you're registered" before the webhook landed, just in a format
// people forget they subscribed to.

export const dynamic = "force-dynamic";

function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}
function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export async function GET(
  _req: Request,
  context: { params: Promise<{ registrationId: string }> },
) {
  const { registrationId } = await context.params;
  const loaded = await loadRegistrationPage(registrationId);
  if (!loaded) return new Response("Not found", { status: 404 });

  const { ctx } = loaded;
  const tentative = ctx.waitingOn === "COACH" || ctx.waitingOn === "PARENT";
  const canceled = ctx.waitingOn === "CANCELED";

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//AthletixOS//Event Registration//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:registration-${registrationId}@athletix-os.com`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(loaded.startsAt)}`,
    `DTEND:${stamp(loaded.endsAt)}`,
    `SUMMARY:${esc(loaded.eventName)}${tentative ? " (awaiting approval)" : ""}`,
    `STATUS:${canceled ? "CANCELLED" : tentative ? "TENTATIVE" : "CONFIRMED"}`,
    `DESCRIPTION:${esc(`${ctx.headline}. ${ctx.chargeTiming} Confirmation #${loaded.confirmationCode}. ${ctx.confirmationUrl}`)}`,
    ...(loaded.locationName ? [`LOCATION:${esc(loaded.locationName)}`] : []),
    `URL:${ctx.confirmationUrl}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];

  return new Response(lines.join("\r\n"), {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": `attachment; filename="${loaded.confirmationCode}.ics"`,
      "cache-control": "no-store",
    },
  });
}
