import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requireOwner } from "@/lib/apiGuard";
import { rateLimit, rateLimitedResponse } from "@/lib/ratelimit";

// GET /api/geocode?q=<address> — owner-only address → coordinates lookup for
// the Locations editor, so nobody has to hand-copy lat/long out of Google
// Maps. Proxies OpenStreetMap Nominatim server-side (their usage policy wants
// an identifying User-Agent and ≤1 req/s — an owner clicking a button in a
// settings modal is far inside that; the rate limit below keeps it honest).
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requireOwner(session);
  if (denied) return denied;

  const rl = rateLimit({ key: `geocode:${session.user.id}`, limit: 10, windowMs: 60_000 });
  if (!rl.allowed) return rateLimitedResponse(rl);

  const q = new URL(req.url).searchParams.get("q")?.trim();
  if (!q || q.length < 4) {
    return NextResponse.json({ error: "Enter the address first." }, { status: 400 });
  }

  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`,
      {
        headers: {
          "User-Agent": "AthletixOS/1.0 (https://athletix-os.com; support@athletix-os.com)",
          Accept: "application/json",
        },
        // Nominatim can be slow; don't hang the modal forever.
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!res.ok) throw new Error(`geocoder ${res.status}`);
    const results = (await res.json()) as Array<{ lat: string; lon: string; display_name: string }>;
    const hit = results[0];
    if (!hit) {
      return NextResponse.json(
        { error: "Couldn't find that address — try adding the city and state." },
        { status: 404 },
      );
    }
    return NextResponse.json({
      latitude: Number(hit.lat),
      longitude: Number(hit.lon),
      displayName: hit.display_name,
    });
  } catch (err) {
    console.error("Geocode failed:", err);
    return NextResponse.json(
      { error: "Address lookup is unavailable right now — you can still enter coordinates manually." },
      { status: 502 },
    );
  }
}
