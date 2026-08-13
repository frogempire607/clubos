import { notFound } from "next/navigation";
import { loadRegistrationPage } from "@/lib/registrationPage";
import RegistrationCard from "@/components/registration/RegistrationCard";

// GET /e/[slug]/registered/[registrationId] — §5.2.3.
//
// The one address for a registration, for its whole lifetime. Server-rendered
// from the actual row every time it is opened, so the parent who bookmarks it
// after registering sees the coach's decision when they come back rather than
// the snapshot they landed on. Nothing here reads a query parameter to decide
// what to say — `?src=paid` on the Stripe return is not evidence that anything
// was paid, and treating it as such is the bug this route replaces.

export const dynamic = "force-dynamic";

export default async function RegistrationConfirmationPage({
  params,
}: {
  params: Promise<{ slug: string; registrationId: string }>;
}) {
  const { registrationId } = await params;
  const loaded = await loadRegistrationPage(registrationId);
  if (!loaded) notFound();

  return (
    <div className="min-h-screen bg-stone-50 py-8 px-4">
      <RegistrationCard ctx={loaded.ctx} timeZone={loaded.timeZone} />
    </div>
  );
}
