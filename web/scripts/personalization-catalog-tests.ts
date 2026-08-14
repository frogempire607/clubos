// Pure tests for lib/personalizationCatalog.ts.
//   npx tsx scripts/personalization-catalog-tests.ts

import { PERSONALIZATION_TOKENS } from "../lib/emailPersonalization";
import {
  TOKEN_CATALOG,
  groupedTokens,
  tokenInfo,
  tokenSyntax,
  catalogCoversEveryToken,
  SOURCE_LABEL,
  SOURCE_NOTE,
} from "../lib/personalizationCatalog";

let pass = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ✓ ${label}`); return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
}

// ── The whole point: no token may be missing from the picker ──────────────
{
  const cov = catalogCoversEveryToken();
  check(
    "every interpolator token is described in the catalog",
    cov.ok,
    cov.missing.length ? `missing: ${cov.missing.join(", ")}` : `extra: ${cov.extra.join(", ")}`,
  );
  check("the catalog invents no tokens the interpolator doesn't know", cov.extra.length === 0);
  check("counts line up", TOKEN_CATALOG.length === PERSONALIZATION_TOKENS.length);
}

// ── Syntax must match what the interpolator matches ───────────────────────
{
  check("syntax wraps in double braces", tokenSyntax("member_first_name") === "{{member_first_name}}");
  // The interpolator's regex is /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g — assert the
  // generated syntax actually satisfies it, rather than assuming.
  const re = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/;
  for (const t of TOKEN_CATALOG) {
    const m = re.exec(tokenSyntax(t.token));
    if (!m || m[1] !== t.token) {
      check(`${t.token} produces interpolator-matchable syntax`, false, tokenSyntax(t.token));
      break;
    }
  }
  check("every token produces interpolator-matchable syntax", TOKEN_CATALOG.every((t) => {
    const m = re.exec(tokenSyntax(t.token));
    return !!m && m[1] === t.token;
  }));
}

// ── Descriptions are real ─────────────────────────────────────────────────
{
  check("every entry has a label", TOKEN_CATALOG.every((t) => t.label.trim().length > 0));
  check("every entry has a description", TOKEN_CATALOG.every((t) => t.description.trim().length > 8));
  check("no label is just the raw token", TOKEN_CATALOG.every((t) => t.label !== t.token));
  check("labels are unique", new Set(TOKEN_CATALOG.map((t) => t.label)).size === TOKEN_CATALOG.length);
}

// ── Grouping ──────────────────────────────────────────────────────────────
{
  const g = groupedTokens();
  check("recipient group comes first", g[0].source === "RECIPIENT");
  check("context group comes last", g[g.length - 1].source === "CONTEXT");
  check("grouping loses nothing", g.reduce((n, x) => n + x.tokens.length, 0) === TOKEN_CATALOG.length);

  // The trap: a Members-tab send supplies no context, so these resolve blank
  // for everyone. They must be labelled as unavailable, not merely grouped.
  check("context tokens are labelled as unavailable", SOURCE_LABEL.CONTEXT.toLowerCase().includes("not available"));
  check("context group explains why", (SOURCE_NOTE.CONTEXT ?? "").length > 40);
  check("recipient/club groups carry no scary note", SOURCE_NOTE.RECIPIENT === null && SOURCE_NOTE.CLUB === null);

  const contextTokens = g.find((x) => x.source === "CONTEXT")!.tokens.map((t) => t.token);
  for (const t of ["event_name", "class_name", "coach_name", "registration_link", "payment_link"]) {
    check(`${t} is context-supplied`, contextTokens.includes(t as never));
  }
  // migration_link is per-RECIPIENT (activationToken), not context — getting
  // this wrong would hide the one token a migration reminder needs.
  check("migration_link is recipient-scoped, not context", tokenInfo("migration_link")?.source === "RECIPIENT");
}

// ── Lookup ────────────────────────────────────────────────────────────────
{
  check("known token resolves", tokenInfo("club_name")?.label === "Club name");
  check("unknown token returns null", tokenInfo("not_a_token") === null);
}

console.log(`\n${"─".repeat(58)}`);
if (failures.length) {
  console.log(`✗ ${failures.length} failed, ${pass} passed\n`);
  failures.forEach((f) => console.log(`   ${f}`));
  process.exit(1);
}
console.log(`✓ ${pass}/${pass} passed`);
