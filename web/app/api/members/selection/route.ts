// Phase 4.5.2 §1f — resolve a query-scoped bulk selection into member ids.
//
// The roster's "Select all N matching this filter" sends an INTENT, not a list
// of loaded ids. Without this route the client could only ever act on the page
// it had rendered — which is precisely the bug the handoff calls out ("bulk
// actions silently apply to page one"). `resolveSelection` has existed in
// lib/membersQuery.ts since session 2 with nothing calling it; this is the call.
//
// It reads. It never mutates. The caller then passes the returned ids to a real
// action route, each of which does its own permission check — this endpoint's
// members:view gate is about who may enumerate the roster, not who may act.

import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requirePermission } from "@/lib/apiGuard";
import { parseMemberFilters, resolveSelection } from "@/lib/membersQuery";

// Bounded so a hostile client can't ask us to hydrate an unbounded id list.
const MAX_IDS = 5_000;

const schema = z.object({
  mode: z.enum(["ids", "allMatching"]),
  ids: z.array(z.string()).max(MAX_IDS).optional(),
  /** The roster's current URL query, verbatim — same parser as the list. */
  filter: z.record(z.string()).optional(),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "members", "view");
  if (denied) return denied;

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json().catch(() => ({})));
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    throw err;
  }

  // Re-parse the filter through the SAME parser the list uses, so a selection
  // can never resolve against different rules than the count the staffer read.
  // parseMemberFilters reads a URL, so rebuild one from the posted query. The
  // origin is irrelevant and never leaves this function — only searchParams is read.
  const filter = body.filter
    ? parseMemberFilters(
        new URL(`https://internal.invalid/?${new URLSearchParams(body.filter).toString()}`),
      )
    : undefined;

  const ids = await resolveSelection(session.user.clubId, {
    mode: body.mode,
    ids: body.ids,
    filter,
  });

  return NextResponse.json({ ids, count: ids.length });
}
