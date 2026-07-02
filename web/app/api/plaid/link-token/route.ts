import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { plaidClient, PLAID_ENV } from "@/lib/plaid";
import { prisma } from "@/lib/prisma";
import { getTierFeatures } from "@/lib/tier";
import { CountryCode, Products } from "plaid";

export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Plaid bank sync requires Growth plan or higher
  const club = await prisma.club.findUnique({
    where: { id: session.user.clubId },
    select: { tier: true },
  });
  const features = getTierFeatures(club?.tier ?? "growth");
  if (!features.plaid) {
    return NextResponse.json(
      {
        error: "Plaid bank sync is available on Pro and Enterprise plans.",
        code: "UPGRADE_REQUIRED",
        upgradeRequired: "pro",
      },
      { status: 403 }
    );
  }

  if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET) {
    return NextResponse.json({ error: "Plaid not configured" }, { status: 503 });
  }

  try {
    const res = await plaidClient.linkTokenCreate({
      user: { client_user_id: session.user.id },
      client_name: "AthletixOS",
      products: [Products.Transactions],
      country_codes: [CountryCode.Us],
      language: "en",
    });

    return NextResponse.json({ linkToken: res.data.link_token });
  } catch (err) {
    // Plaid's SDK throws an Axios error whose response body is the structured
    // PlaidError ({ error_type, error_code, error_message, ... }). Surface the
    // real reason instead of a generic 500. This route is OWNER-only, so
    // exposing the Plaid error code to the caller here is safe and lets the
    // club owner self-diagnose (e.g. INVALID_API_KEYS = wrong secret for env).
    const data =
      typeof err === "object" && err !== null && "response" in err
        ? (err as { response?: { data?: Record<string, unknown> } }).response?.data
        : undefined;
    const code = typeof data?.error_code === "string" ? data.error_code : undefined;
    const message = typeof data?.error_message === "string" ? data.error_message : undefined;

    console.error("Plaid link-token error:", {
      env: PLAID_ENV,
      error_type: data?.error_type,
      error_code: code,
      error_message: message,
      raw: data ?? (err instanceof Error ? err.message : err),
    });

    const detail = code
      ? `Plaid (${PLAID_ENV}) rejected the request: ${code}${message ? ` — ${message}` : ""}`
      : `Failed to create link token (targeting Plaid "${PLAID_ENV}" environment).`;

    return NextResponse.json(
      { error: detail, plaidEnv: PLAID_ENV, plaidErrorCode: code ?? null },
      { status: 500 }
    );
  }
}
