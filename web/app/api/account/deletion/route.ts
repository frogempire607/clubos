import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { deletionConfirmed, planAccountDeletion } from "@/lib/accountDeletion";
import { deleteOwnAccount, loadAccountDeletion } from "@/lib/accountDeletionServer";
import { rateLimit, rateLimitedResponse } from "@/lib/ratelimit";

// /api/account/deletion — delete YOUR OWN account. Every signed-in person:
// member, parent, staff, owner. It acts only on the caller's own row.
//
//   GET     what will be removed, what is kept and why, and anything that
//           needs saying first (children, a membership still being charged)
//   DELETE  { confirm: "delete" } — does it, then the client signs out

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const loaded = await loadAccountDeletion(session.user.id, session.user.clubId);
  if (!loaded) return NextResponse.json({ error: "This account no longer exists." }, { status: 404 });
  return NextResponse.json({ role: loaded.facts.role, plan: planAccountDeletion(loaded.facts) });
}

export async function DELETE(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rl = rateLimit({ key: `account-delete:${session.user.id}`, limit: 5, windowMs: 60_000 });
  if (!rl.allowed) return rateLimitedResponse(rl, "Too many attempts. Wait a moment and try again.");

  const body = (await req.json().catch(() => null)) as { confirm?: string } | null;
  if (!deletionConfirmed(body?.confirm)) {
    return NextResponse.json({ error: 'Type "delete" to confirm.', code: "CONFIRM_REQUIRED" }, { status: 400 });
  }

  const result = await deleteOwnAccount({
    userId: session.user.id,
    clubId: session.user.clubId,
    actorName: session.user.name ?? null,
  });
  if (!result.ok) return NextResponse.json({ error: result.error, plan: result.plan ?? null }, { status: result.status });
  return NextResponse.json({ ok: true, cancelRequestsFiled: result.cancelRequestsFiled });
}
