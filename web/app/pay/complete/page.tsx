import Link from "next/link";
import { CheckCircle2, Clock, AlertOctagon } from "lucide-react";
import { prisma } from "@/lib/prisma";

// Public payment-confirmation page for event payment links.
//
// Stripe Checkout REQUIRES a success_url and a cancel_url, and bill-registrants
// used to build them as `/e/${event.publicSlug ?? ""}`. Events that aren't
// publicly listed have no slug, so every parent who paid landed on
// `/e/?paid=true` — a URL that matches no route and 404s. They'd have been
// charged correctly and shown a dead page (Frog Empire Road Trip, whose 13
// invoices were about to go out with exactly that link).
//
// Unauthenticated on purpose: event registrants are frequently not members and
// have no login. Deliberately shows the event and the amount but NOT the
// registrant's name or email — the id in the URL is a confirmation key, not an
// authorization to read someone's contact details.

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<{ reg?: string; status?: string }> };

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-stone-50 py-12 px-4">
      <div className="max-w-md mx-auto">{children}</div>
    </div>
  );
}

export default async function PaymentCompletePage({ searchParams }: Props) {
  const { reg: regId, status } = await searchParams;
  const canceled = status === "canceled";

  // A missing or unknown id must still render a sane page — never a 404, never
  // a crash. Someone has just been charged; the last thing they should meet is
  // an error screen.
  const reg = regId
    ? await prisma.eventRegistration
        .findUnique({
          where: { id: regId },
          select: {
            status: true,
            amountDue: true,
            amountPaid: true,
            paymentUrl: true,
            event: { select: { name: true, startsAt: true } },
            club: { select: { name: true } },
          },
        })
        .catch(() => null)
    : null;

  const eventName = reg?.event?.name ?? null;
  const clubName = reg?.club?.name ?? null;
  const amount = reg?.amountPaid != null ? Number(reg.amountPaid) : reg?.amountDue != null ? Number(reg.amountDue) : null;
  const settled = reg?.status === "PAID";

  if (canceled) {
    return (
      <Shell>
        <div className="bg-white rounded-xl border border-stone-200 p-8 text-center">
          <AlertOctagon className="h-10 w-10 mx-auto mb-3 text-stone-400" strokeWidth={1.5} />
          <h1 className="text-lg font-semibold text-stone-900 mb-1">Checkout canceled</h1>
          <p className="text-sm text-stone-500">
            You have not been charged{eventName ? ` for ${eventName}` : ""}. Your payment link is still
            valid — you can finish whenever you&apos;re ready.
          </p>
          {reg?.paymentUrl && !settled && (
            <a
              href={reg.paymentUrl}
              className="inline-block mt-5 px-5 py-2.5 rounded-lg bg-stone-900 text-white text-sm font-medium hover:bg-stone-800"
            >
              Try again
            </a>
          )}
          {clubName && (
            <p className="text-xs text-stone-400 mt-5">Questions? Contact {clubName}.</p>
          )}
        </div>
      </Shell>
    );
  }

  // Stripe redirects here the moment the payment succeeds, which can beat the
  // webhook that marks the registration PAID. Never claim more than we know:
  // the money is confirmed by Stripe either way, the record just catches up.
  return (
    <Shell>
      <div className="bg-white rounded-xl border border-stone-200 p-8 text-center">
        {settled ? (
          <CheckCircle2 className="h-10 w-10 mx-auto mb-3 text-green-600" strokeWidth={1.5} />
        ) : (
          <Clock className="h-10 w-10 mx-auto mb-3 text-stone-400" strokeWidth={1.5} />
        )}
        <h1 className="text-lg font-semibold text-stone-900 mb-1">
          {settled ? "Payment received" : "Payment submitted"}
        </h1>
        <p className="text-sm text-stone-500">
          {settled
            ? "Thank you — your payment is confirmed and a receipt has been emailed to you."
            : "Thank you — your payment went through. We're confirming it now, and a receipt will be emailed to you shortly."}
        </p>

        {(eventName || amount != null) && (
          <div className="mt-5 pt-5 border-t border-stone-200 text-sm">
            {eventName && (
              <div className="flex items-center justify-between py-1">
                <span className="text-stone-500">Event</span>
                <span className="text-stone-900 font-medium">{eventName}</span>
              </div>
            )}
            {amount != null && amount > 0 && (
              <div className="flex items-center justify-between py-1">
                <span className="text-stone-500">Amount</span>
                <span className="text-stone-900 font-medium">${amount.toFixed(2)}</span>
              </div>
            )}
          </div>
        )}

        <p className="text-xs text-stone-400 mt-6">
          {clubName ? `Questions? Contact ${clubName}.` : "You can close this page."}
        </p>
        <Link href="/member" className="inline-block mt-3 text-xs text-stone-500 underline">
          Member portal
        </Link>
      </div>
    </Shell>
  );
}
