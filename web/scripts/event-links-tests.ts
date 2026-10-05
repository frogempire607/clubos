// lib/eventLinks — labeled external links on an event. PURE: no database.
//
//   npx tsx scripts/event-links-tests.ts

import {
  normalizeLinkUrl, normalizeEventLinks, normalizeEventLinksDetailed, eventLinksForRead,
  hostLabel, linkProblem, eventLinksText, MAX_EVENT_LINKS, MAX_LINK_LABEL, MAX_LINK_URL,
} from "../lib/eventLinks";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (name: string, got: unknown, want: unknown) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

console.log("\nURL:");
eq("https kept", normalizeLinkUrl("https://example.com/reg?id=4"), "https://example.com/reg?id=4");
eq("http kept", normalizeLinkUrl("http://example.com/reg"), "http://example.com/reg");
eq("scheme added", normalizeLinkUrl("example.com/reg"), "https://example.com/reg");
eq("www, no scheme", normalizeLinkUrl("www.example.com"), "https://www.example.com/");
eq("protocol-relative", normalizeLinkUrl("//example.com/x"), "https://example.com/x");
eq("trimmed", normalizeLinkUrl("   https://example.com/a  "), "https://example.com/a");
eq("uppercase scheme", normalizeLinkUrl("HTTPS://Example.com/A"), "https://example.com/A");
eq("host:port without scheme", normalizeLinkUrl("example.com:8080/x"), "https://example.com:8080/x");
eq("fragment and query survive", normalizeLinkUrl("https://example.com/a?b=1&c=2#top"), "https://example.com/a?b=1&c=2#top");
eq("javascript: refused", normalizeLinkUrl("javascript:alert(1)"), null);
eq("JaVaScRiPt: refused", normalizeLinkUrl("JaVaScRiPt:alert(1)"), null);
eq("javascript with newline refused", normalizeLinkUrl("java\nscript:alert(1)"), null);
eq("javascript with tab refused", normalizeLinkUrl("java\tscript:alert(1)"), null);
eq("data: refused", normalizeLinkUrl("data:text/html,<script>1</script>"), null);
eq("mailto: refused", normalizeLinkUrl("mailto:coach@example.com"), null);
eq("tel: refused", normalizeLinkUrl("tel:6075551234"), null);
eq("file: refused", normalizeLinkUrl("file:///etc/passwd"), null);
eq("ftp: refused", normalizeLinkUrl("ftp://example.com/x"), null);
eq("vbscript: refused", normalizeLinkUrl("vbscript:msgbox(1)"), null);
eq("http:example.com (no slashes) refused", normalizeLinkUrl("http:example.com"), null);
eq("spaces inside refused", normalizeLinkUrl("https://example.com/a b"), null);
eq("plain words refused", normalizeLinkUrl("see the flyer"), null);
eq("single word refused", normalizeLinkUrl("registration"), null);
eq("credentials refused", normalizeLinkUrl("https://user:pw@example.com/"), null);
eq("empty → null", normalizeLinkUrl("   "), null);
eq("non-string → null", normalizeLinkUrl(42), null);
eq("null → null", normalizeLinkUrl(null), null);
eq("too long refused", normalizeLinkUrl(`https://example.com/${"a".repeat(MAX_LINK_URL)}`), null);
check("exactly at the limit kept", normalizeLinkUrl(`https://example.com/${"a".repeat(MAX_LINK_URL - 20)}`)?.length === MAX_LINK_URL);
check("output always starts http(s)://", ["example.com", "//example.com", "https://example.com"].every((u) => /^https?:\/\//.test(normalizeLinkUrl(u) ?? "")));

console.log("\nLabels:");
eq("hostLabel strips www", hostLabel("https://www.example.com/x"), "example.com");
eq("hostLabel bad → empty", hostLabel("nope"), "");
eq("label trimmed", normalizeEventLinks([{ label: "  Hotel block  ", url: "example.com" }])[0].label, "Hotel block");
eq("inner whitespace collapsed", normalizeEventLinks([{ label: "Hotel \n  block", url: "example.com" }])[0].label, "Hotel block");
eq("blank label → hostname", normalizeEventLinks([{ label: "   ", url: "https://www.example.com/reg" }])[0].label, "example.com");
eq("missing label → hostname", normalizeEventLinks([{ url: "https://sub.example.org/reg" }])[0].label, "sub.example.org");
eq("long label cut to 40", normalizeEventLinks([{ label: "x".repeat(90), url: "example.com" }])[0].label.length, MAX_LINK_LABEL);
eq("non-string label → hostname", normalizeEventLinks([{ label: 7, url: "example.com" }])[0].label, "example.com");

console.log("\nLists:");
eq("not an array → []", normalizeEventLinks("https://example.com"), []);
eq("null → []", normalizeEventLinks(null), []);
eq("undefined → []", normalizeEventLinks(undefined), []);
eq("junk rows skipped", normalizeEventLinks([null, 3, "x", {}, { label: "Only a label" }]), []);
eq("blank row dropped", normalizeEventLinks([{ label: "", url: "" }, { label: "A", url: "a.example.com" }]), [{ label: "A", url: "https://a.example.com/" }]);
eq("order kept", normalizeEventLinks([{ label: "B", url: "b.example.com" }, { label: "A", url: "a.example.com" }]).map((l) => l.label), ["B", "A"]);
eq("duplicate url dropped, first wins", normalizeEventLinks([{ label: "First", url: "https://example.com/x" }, { label: "Second", url: "example.com/x" }]), [{ label: "First", url: "https://example.com/x" }]);
eq("duplicate ignoring case + trailing slash", normalizeEventLinks([{ label: "A", url: "https://Example.com" }, { label: "B", url: "https://example.com/" }]).length, 1);
eq("same host, different path kept", normalizeEventLinks([{ label: "A", url: "example.com/a" }, { label: "B", url: "example.com/b" }]).length, 2);
const many = Array.from({ length: 12 }, (_, i) => ({ label: `L${i}`, url: `https://example.com/${i}` }));
eq("capped at 8", normalizeEventLinks(many).length, MAX_EVENT_LINKS);
eq("cap keeps the first 8", normalizeEventLinks(many).map((l) => l.label), ["L0", "L1", "L2", "L3", "L4", "L5", "L6", "L7"]);
eq("truncated flagged", normalizeEventLinksDetailed(many).truncated, true);
eq("8 exactly not flagged", normalizeEventLinksDetailed(many.slice(0, 8)).truncated, false);
eq("bad rows don't count toward the cap", normalizeEventLinks([{ label: "bad", url: "javascript:1" }, ...many.slice(0, 8)]).length, 8);
eq("bad url dropped from the list", normalizeEventLinks([{ label: "Bad", url: "javascript:alert(1)" }, { label: "Good", url: "example.com" }]), [{ label: "Good", url: "https://example.com/" }]);
eq("bad url reported", normalizeEventLinksDetailed([{ label: "Bad", url: "javascript:alert(1)" }]).rejected.length, 1);
eq("extra keys stripped", normalizeEventLinks([{ label: "A", url: "example.com", onclick: "x", id: 9 }]), [{ label: "A", url: "https://example.com/" }]);
eq("idempotent", normalizeEventLinks(normalizeEventLinks(many)), normalizeEventLinks(many));

console.log("\nRead (with the old registrationLink column):");
eq("externalLinks win", eventLinksForRead({ externalLinks: [{ label: "Host", url: "https://host.example.com" }], registrationLink: "https://old.example.com" }), [{ label: "Host", url: "https://host.example.com/" }]);
eq("legacy surfaced when no links", eventLinksForRead({ externalLinks: null, registrationLink: "https://old.example.com/reg" }), [{ label: "Registration", url: "https://old.example.com/reg" }]);
eq("legacy surfaced when links is []", eventLinksForRead({ externalLinks: [], registrationLink: "old.example.com/reg" }), [{ label: "Registration", url: "https://old.example.com/reg" }]);
eq("legacy surfaced when stored links are all junk", eventLinksForRead({ externalLinks: [{ label: "x", url: "javascript:1" }], registrationLink: "https://old.example.com/" }), [{ label: "Registration", url: "https://old.example.com/" }]);
eq("unsafe legacy ignored", eventLinksForRead({ externalLinks: null, registrationLink: "javascript:alert(1)" }), []);
eq("blank legacy ignored", eventLinksForRead({ externalLinks: null, registrationLink: "  " }), []);
eq("nothing → []", eventLinksForRead({}), []);
eq("null event → []", eventLinksForRead(null), []);
eq("stored junk never reaches an href", eventLinksForRead({ externalLinks: [{ label: "x", url: "data:text/html,hi" }, { label: "ok", url: "https://example.com/" }] }), [{ label: "ok", url: "https://example.com/" }]);

console.log("\nEditor messages + email text:");
eq("clean list → no problem", linkProblem([{ label: "A", url: "example.com" }, { label: "", url: "" }]), null);
check("bad address named", (linkProblem([{ label: "A", url: "see flyer" }]) ?? "").includes("see flyer"));
check("too many named", (linkProblem(many) ?? "").includes("up to 8"));
eq("email text", eventLinksText([{ label: "Host page", url: "https://example.com/a" }, { label: "Hotel", url: "https://example.com/b" }]), "Host page: https://example.com/a\nHotel: https://example.com/b");
eq("email text empty", eventLinksText([]), "");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
