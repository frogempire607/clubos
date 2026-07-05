import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getAppPrisma, tenantPrismaFromSession, assertRlsEnforced } from "@/lib/tenantPrisma";

// ⚠️  TEMPORARY RLS DIAGNOSTIC — DELETE THIS ENTIRE FOLDER BEFORE MERGING  ⚠️
//
// Purpose: prove, from inside the running app, that the RLS tenant client
// actually connects as the RLS-enforced `athletix_app` role via
// APP_DATABASE_URL — and is NOT silently falling back to a bypass role
// (postgres / superuser / table owner), which would make RLS do nothing.
//
// It exists ONLY to verify the Step-5 pilot (GET /api/documents/[id]/signatures)
// in the preview deploy. Owner-only, read-only, no data mutated. Remove the
// `app/api/rls-diagnostic` folder before this PR merges to main.
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Owner access required" }, { status: 403 });
  }

  try {
    // The exact client the pilot route uses (wrapped: every query runs as
    // athletix_app inside a transaction that first sets app.club_id).
    const db = tenantPrismaFromSession(session);

    // (1) Who is this connection, really? Observed on the app's own client.
    const roleRows = await db.$queryRaw<
      Array<{ role_name: string; login_name: string; is_superuser: string }>
    >`SELECT current_user::text  AS role_name,
             session_user::text  AS login_name,
             current_setting('is_superuser') AS is_superuser`;
    const role = roleRows[0];

    // (2) Fail-closed proof — RAW app-role connection with NO app.club_id set.
    //     `clubs` always has rows, so under RLS as a non-bypass role this MUST
    //     be 0. A non-zero count means the connection is bypassing RLS.
    const withoutGuc = await getAppPrisma().$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM clubs`;
    const clubsVisibleWithoutGuc = withoutGuc[0]?.n ?? null;

    // (3) Positive control — through the tenant wrapper (GUC = your clubId),
    //     you should see exactly your own club → 1.
    const withGuc = await db.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM clubs`;
    const clubsVisibleWithGuc = withGuc[0]?.n ?? null;

    // (4) The codebase's canonical gate (throws if role bypasses / owns tables).
    let assertRlsResult = "passed";
    try {
      await assertRlsEnforced();
    } catch (e) {
      assertRlsResult = `threw: ${e instanceof Error ? e.message : String(e)}`;
    }

    const enforced =
      !!role &&
      role.role_name !== "postgres" &&
      role.is_superuser === "off" &&
      clubsVisibleWithoutGuc === 0 &&
      assertRlsResult === "passed";

    return NextResponse.json({
      verdict: enforced
        ? "RLS ENFORCED — the route uses athletix_app / APP_DATABASE_URL. Safe to merge."
        : "RLS NOT ENFORCED — connection is bypassing RLS (wrong role / DATABASE_URL). DO NOT MERGE.",
      current_user: role?.role_name ?? null, //   expect: athletix_app
      session_user: role?.login_name ?? null, //  expect: athletix_app
      is_superuser: role?.is_superuser ?? null, // expect: off
      clubs_visible_without_guc: clubsVisibleWithoutGuc, // expect: 0  (fail-closed)
      clubs_visible_with_guc: clubsVisibleWithGuc, //       expect: 1  (your own club)
      assert_rls_enforced: assertRlsResult, //              expect: passed
      your_club_id: session.user.clubId ?? null,
      note: "TEMPORARY diagnostic — delete app/api/rls-diagnostic before merging.",
    });
  } catch (e) {
    // A thrown error here (e.g. 'APP_DATABASE_URL is not set') is itself a
    // FAIL signal — surface it plainly for the owner running the check.
    return NextResponse.json(
      {
        verdict: "ERROR — could not run the check (see error).",
        error: e instanceof Error ? e.message : String(e),
      },
      { status: 500 },
    );
  }
}
