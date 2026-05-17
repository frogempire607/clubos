import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { searchHelp, HELP_ARTICLES, HELP_CATEGORIES } from "@/lib/helpContent";

// GET /api/help/search?q=
// Keyword retrieval over the help knowledge base. This endpoint is the
// retrieval layer a future AI assistant will call (retrieve → summarize).
// No AI logic here — it returns the matching articles only.
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const q = (new URL(req.url).searchParams.get("q") || "").trim();
  const articles = q ? searchHelp(q, 10) : HELP_ARTICLES;

  return NextResponse.json({
    query: q,
    categories: HELP_CATEGORIES,
    articles,
  });
}
