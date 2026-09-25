// Duplicate detection — the nickname / birth-year / missing-birthday rules
// added 2026-09-25 (nine real pairs the old rules missed). PURE.
//
//   npm run test:member-duplicates
import { canonicalFirstName, groupDuplicates, duplicateReasonLabel, type DuplicateCandidate } from "../lib/memberDuplicates";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) pass++; else fail++;
  console.log(`${cond ? "  ✓" : "  ✗"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
};
let n = 0;
const m = (firstName: string, lastName: string, dob: string | null, extra: Partial<DuplicateCandidate> = {}): DuplicateCandidate => ({
  id: `m${++n}`, firstName, lastName, dateOfBirth: dob ? new Date(dob) : null, email: null, phone: null, guardianEmail: null, guardianPhone: null, ...extra,
});
const grouped = (...ms: DuplicateCandidate[]) => groupDuplicates(ms);
const oneGroup = (...ms: DuplicateCandidate[]) => { const g = grouped(...ms); return g.length === 1 && g[0].members.length === ms.length ? g[0] : null; };

console.log("canonical first names");
ok("Zach → zachary", canonicalFirstName("Zach") === "zachary");
ok("Zachary → zachary", canonicalFirstName("Zachary") === "zachary");
ok("Adam (AJ) → adam", canonicalFirstName("Adam (AJ)") === "adam");
ok("Rusty → russell", canonicalFirstName("Rusty") === "russell");
ok("case/space", canonicalFirstName("  dean ") === "dean");
ok("unknown stays", canonicalFirstName("Maximus") === "maximus");

console.log("the nine production pairs (shape)");
ok("Zach / Zachary Boudreau, same birthday", !!oneGroup(m("Zach", "Boudreau", "2011-05-12"), m("Zachary", "Boudreau", "2011-05-12", { guardianEmail: "other@x.com" })));
ok("Russell / Rusty Chandler, same birthday", !!oneGroup(m("Russell", "Chandler", "2014-07-07"), m("Rusty", "Chandler", "2014-07-07")));
const aj = oneGroup(m("Adam", "Dorn", "2011-09-15"), m("Adam (AJ)", "Dorn", "2012-09-15"));
ok("Adam / Adam (AJ) Dorn, birth year differs", !!aj);
ok("… labelled as a year mismatch", duplicateReasonLabel(aj?.reasons) === "same name & birthday, different year", duplicateReasonLabel(aj?.reasons));
const nodob = oneGroup(m("Alex", "Butler", "2018-02-20"), m("Alex", "Butler", null));
ok("Alex Butler, one copy with no birthday", !!nodob);
ok("… labelled", duplicateReasonLabel(nodob?.reasons) === "same name, one has no birthday", duplicateReasonLabel(nodob?.reasons));
ok("Ryot Belles, neither has a birthday", !!oneGroup(m("Ryot", "Belles", null), m("Ryot", "Belles", null)));
ok("trailing space in last name (Michael 'Lister ')", !!oneGroup(m("Mike", "Lister ", "1980-01-01"), m("Michael", "Lister", "1980-01-01")));

console.log("must NOT cluster");
ok("siblings, same surname, different names, same guardian", grouped(m("Alex", "Butler", "2018-02-20", { guardianEmail: "g@x.com" }), m("Mikey", "Butler", "2015-08-08", { guardianEmail: "g@x.com" })).length === 0);
ok("twins: same birthday, different first names", grouped(m("Jacob", "Meyer", "2011-07-06"), m("Hunter", "Meyer", "2011-07-06")).length === 0);
ok("same name, two DIFFERENT full birthdays (not same day)", grouped(m("Sam", "Smith", "2010-01-02"), m("Samuel", "Smith", "2014-06-30")).length === 0);
ok("same birthday, unrelated first names", grouped(m("Zach", "Boudreau", "2011-05-12"), m("Colin", "Boudreau", "2011-05-12")).length === 0);
ok("different surname", grouped(m("Zach", "Boudreau", null), m("Zach", "Smith", null)).length === 0);

console.log("still works");
const exact = oneGroup(m("Dean", "vargason", "2014-01-01"), m("dean", "vargason", "2014-01-01"));
ok("exact name + dob", !!exact);
ok("… labelled name & dob only", duplicateReasonLabel(exact?.reasons) === "same name & date of birth", duplicateReasonLabel(exact?.reasons));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
