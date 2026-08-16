// Browser test for Phase 7.2/7.3 — driven as a dad signing up his son.
//
//   ./scripts/dev-signup-intent-test.sh          # in one terminal
//   npx tsx scripts/browser-signup-intent.ts     # in another
//
// This is AJ Dorn's signup, re-run against the fixed form. The questions it
// answers are the ones the audit could only answer by reading production rows:
//
//   1. Does the form say WHOSE account is being created, before anything is typed?
//   2. Does one submission produce TWO rows — a guardian User and a child
//      Member with no login — instead of one row doing all three jobs?
//   3. Does the free trial land on the CHILD rather than on the dad's login?
//   4. Does the already-imported sibling appear, without anyone asking?
//   5. Is the old shape — guardian email == account email — actually refused?

import { chromium, type Page } from "playwright";

const BASE = "http://localhost:3000";
const SHOT = "/tmp/claude-0/-home-user-clubos/3016b3c6-0246-508b-9641-e7e724ddb0ba/scratchpad";
const SLUG = "frog-empire-signup";
const PARENT_EMAIL = "dad@local.test";
const PASSWORD = "localtest123";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// The repo's playwright pins a browser build the sandbox doesn't carry, so
// point at whatever chromium IS installed rather than downloading one.
const CHROME = process.env.PW_CHROME || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

async function main() {
  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on("pageerror", (e) => console.log(`  [page error] ${e.message}`));

  // ── Step 1: the picker states the outcome ──────────────────────────────────
  console.log("\nStep 1 — whose account is this?");
  await page.goto(`${BASE}/member/signup?club=${SLUG}&trial=1`);
  await page.waitForLoadState("networkidle");

  const body1 = await page.locator("body").innerText();
  check("the trial the link promises is named", /First Week Free/i.test(body1), body1.slice(0, 200));
  check("the child option is phrased as the parent doing it", /I'm signing my child up/i.test(body1));
  check("the adult option is distinct", /I train here myself/i.test(body1));

  await page.locator("label", { hasText: "I'm signing my child up" }).first().click();
  const afterPick = await page.locator("body").innerText();
  check(
    "picking it says the account will be the PARENT's",
    /We'll create YOUR account, and add your child as an athlete under it/i.test(afterPick),
    afterPick.slice(0, 300),
  );
  await page.screenshot({ path: `${SHOT}/signup-step1.png` });

  await page.locator("button", { hasText: "Continue" }).first().click();

  // ── Step 2: the account holder's own details ───────────────────────────────
  console.log("\nStep 2 — the account holder's details are labelled as theirs");
  await page.waitForTimeout(200);
  const body2 = await page.locator("body").innerText();
  check("fields are labelled as the parent's", /Your first name/i.test(body2), body2.slice(0, 300));
  check(
    "the email field says who will manage the account",
    /Your email — you'll manage this account/i.test(body2),
  );
  check("it says the child's details come next", /We'll ask for your child's on the next step/i.test(body2));
  // The original defect in one assertion: this step must not ask for a DOB,
  // because the only DOB that matters belongs to the child.
  check("no date-of-birth is asked for here", (await page.locator('input[type="date"]').count()) === 0);

  await page.locator('input[type="text"]').first().fill("Adam");
  await page.locator('input[type="text"]').nth(1).fill("Dorn");
  await page.locator('input[type="email"]').fill(PARENT_EMAIL);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.screenshot({ path: `${SHOT}/signup-step2.png` });
  await page.locator("button", { hasText: "Continue" }).first().click();

  // ── Step 3: the child ──────────────────────────────────────────────────────
  console.log("\nStep 3 — the athlete, named as the child");
  await page.waitForTimeout(300);
  const body3 = await page.locator("body").innerText();
  check("asks for the child's name", /Your child's first name/i.test(body3), body3.slice(0, 400));
  check(
    "restates whose account the athlete lands on",
    /They'll appear under your account/i.test(body3) && /dad@local\.test/.test(body3),
  );
  check("says the child needs no login of their own", /don't need their own login/i.test(body3));
  // There must be no second email box to type the parent's address into twice.
  check(
    "there is NO guardian-email field to collide with the account email",
    (await page.locator('input[type="email"]').count()) === 0,
  );

  await page.locator('input[type="text"]').first().fill("AJ");
  await page.locator('input[type="date"]').fill("2012-09-15");
  await page.locator('input[type="checkbox"]').first().check(); // terms
  await page.locator('input[type="checkbox"]').nth(1).check(); // parental consent
  const consentText = await page.locator("label", { hasText: "parent or legal guardian" }).innerText();
  check("the consent line names the child", /AJ/.test(consentText), consentText);
  await page.screenshot({ path: `${SHOT}/signup-step3.png` });

  await page.locator("button", { hasText: "Create account" }).click();
  await page.waitForURL(/\/member(\/|\?|$)/, { timeout: 30_000 });

  // ── Landing ────────────────────────────────────────────────────────────────
  console.log("\nAfter signup — the guardian's portal");
  await page.waitForLoadState("networkidle");
  // Wait for the portal payload to actually render rather than guessing at a
  // timeout — the dev server compiles /api/member/portal on first hit.
  await page
    .waitForFunction(() => /Welcome,|Could not load/.test(document.body.innerText), { timeout: 30_000 })
    .catch(() => {});
  const landing = await page.locator("body").innerText();
  await page.screenshot({ path: `${SHOT}/signup-landed.png`, fullPage: true });

  check("lands on the portal, not a dead end", /\/member/.test(page.url()), page.url());
  check("greets the PARENT by name", /Welcome, Adam/i.test(landing), landing.slice(0, 300));
  check("says the athlete is on the account", /AJ is on your account/i.test(landing));
  check(
    "surfaces the sibling already listed under this email",
    /already listed under your email/i.test(landing),
    landing.slice(0, 500),
  );
  check("says the trial started, and on whom", /Free trial started for AJ/i.test(landing));
  check("both athletes are reachable from here", /AJ/.test(landing) && /Marcus/.test(landing));

  // ── What actually got written ──────────────────────────────────────────────
  console.log("\nWhat the submission wrote");
  const portal = await page.evaluate(async () => {
    const r = await fetch("/api/member/portal", { cache: "no-store" });
    return r.ok ? await r.json() : null;
  });
  check("the account has NO athlete profile of its own", portal?.user?.memberProfile == null);
  check("it manages 2 athletes", (portal?.user?.guardianOf ?? []).length === 2, String((portal?.user?.guardianOf ?? []).length));
  const names = (portal?.user?.guardianOf ?? []).map((g: { member: { firstName: string } }) => g.member.firstName).sort();
  check("…AJ and Marcus", JSON.stringify(names) === JSON.stringify(["AJ", "Marcus"]), JSON.stringify(names));

  // ── The AJ regression, refused at the API ──────────────────────────────────
  console.log("\nThe old shape is refused");
  const rejected = await page.evaluate(
    async ([slug, email]) => {
      const r = await fetch("/api/member/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clubSlug: slug,
          firstName: "Adam (AJ)",
          lastName: "Dorn",
          email: `legacy-${email}`,
          password: "localtest123",
          accountType: "MINOR_ATHLETE",
          dateOfBirth: "2012-09-15",
          // The exact defect: one address as both the account and the guardian.
          guardianEmail: `legacy-${email}`,
          guardianName: "Adam j Dorn, Sr",
          acceptedTerms: true,
          termsVersion: "test",
          privacyVersion: "test",
        }),
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    },
    [SLUG, PARENT_EMAIL] as const,
  );
  check("AJ's original submission is rejected", rejected.status === 400, `got ${rejected.status}`);
  check(
    "…with the guardian-email-is-account-email code",
    rejected.body?.code === "GUARDIAN_EMAIL_IS_ACCOUNT_EMAIL",
    JSON.stringify(rejected.body).slice(0, 200),
  );
  check(
    "…and a message that tells the parent what to do",
    /signing my child up/i.test(String(rejected.body?.error ?? "")),
  );

  // ── The guardian-only path, on a trial link ────────────────────────────────
  // §7.2's other dead end: a parent who picked "Parent" finished the wizard,
  // landed in an empty portal with no athlete and no next step, and emailed the
  // club asking how to add their kid. §7.3's other gap: they'd clicked a trial
  // link and were told nothing at all, because the trial block was skipped
  // whenever `user.memberProfile` was null.
  console.log("\nGuardian-only signup, arriving from a trial link");
  const page2 = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page2.goto(`${BASE}/member/signup?club=${SLUG}&trial=1`);
  await page2.waitForLoadState("networkidle");
  await page2.locator("label", { hasText: "I only manage someone else's account" }).first().click();
  const soloPick = await page2.locator("body").innerText();
  check(
    "the parent-only option promises connection to existing athletes",
    /connect you to athletes the club lists under your email/i.test(soloPick),
  );
  await page2.locator("button", { hasText: "Continue" }).first().click();
  await page2.waitForTimeout(200);
  await page2.locator('input[type="text"]').first().fill("Nadia");
  await page2.locator('input[type="text"]').nth(1).fill("Alvarez");
  await page2.locator('input[type="email"]').fill("nadia@local.test");
  await page2.locator('input[type="password"]').fill(PASSWORD);
  await page2.locator("button", { hasText: "Continue" }).first().click();
  await page2.waitForTimeout(300);
  await page2.locator('input[type="checkbox"]').first().check();
  await page2.locator("button", { hasText: "Create account" }).click();
  await page2.waitForURL(/\/member(\/|\?|$)/, { timeout: 30_000 });
  await page2
    .waitForFunction(() => /Add your athlete|Could not load/.test(document.body.innerText), { timeout: 30_000 })
    .catch(() => {});
  const solo = await page2.locator("body").innerText();
  await page2.screenshot({ path: `${SHOT}/signup-guardian-only.png`, fullPage: true });

  check("a guardian with no athletes is NOT shown an athlete dashboard", !/My Bookings/i.test(solo), solo.slice(0, 400));
  check("…they're told to add their athlete", /Add your athlete/i.test(solo));
  check("…with a way to add one", /Add an athlete/i.test(solo));
  check("…and a way to connect one the club already has", /Connect an existing athlete/i.test(solo));
  check(
    "…and 'do you train here too?' is offered, never assumed",
    /Do you train here too/i.test(solo) && /add it only if you want it/i.test(solo),
  );
  // The §7.3 gap: they clicked a trial link and got nothing. Silence was the
  // bug — the page must say what happened to the trial they were promised.
  check(
    "the unclaimed trial is explained, not swallowed",
    /isn't an athlete itself/i.test(solo) && /Add your athlete and we'll apply it to them/i.test(solo),
    solo.slice(0, 500),
  );

  const soloPortal = await page2.evaluate(async () => {
    const r = await fetch("/api/member/portal", { cache: "no-store" });
    return r.ok ? await r.json() : null;
  });
  check("no athlete profile was invented for them", soloPortal?.user?.memberProfile == null);
  check("and no athlete was linked", (soloPortal?.user?.guardianOf ?? []).length === 0);

  await browser.close();
  console.log(failures === 0 ? "\nAll browser checks passed." : `\n${failures} browser check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
