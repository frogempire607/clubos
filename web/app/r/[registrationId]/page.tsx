import { notFound } from "next/navigation";
import { loadRegistrationPage } from "@/lib/registrationPage";
import RegistrationCard from "@/components/registration/RegistrationCard";

// GET /r/[registrationId] — the same confirmation surface for events with no
// public slug (a members-only camp, an internal clinic). Same loader, same
// resolver, same card: the slug is a nicety in the URL, not a different page.

export const dynamic = "force-dynamic";

export default async function RegistrationConfirmationFallbackPage({
  params,
}: {
  params: Promise<{ registrationId: string }>;
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
