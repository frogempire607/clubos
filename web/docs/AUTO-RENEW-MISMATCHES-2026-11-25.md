# Auto-renew: where the stored flag and reality disagree

Read from production on 2026-11-25, read-only. **Nothing was changed, and none of the SQL below was run.**

## How this was decided

`autoRenew` is a stored flag. What a card membership will actually do is decided by Stripe. Stripe's own stop date (`cancel_at`) was read from the newest `customer.subscription.created` / `updated` event the app has stored for each subscription (`stripe_webhook_events`). All 58 live card memberships have one. Stripe was not called.

| Live memberships (active, past due or pending) | Count |
|---|---|
| Card, flag and Stripe agree | 44 |
| Card, flag says "renews", Stripe will stop it | **12** |
| Card, flag says "doesn't renew", Stripe has no stop | **1** |
| Card, flag says "renews" and it will, but our end date says otherwise | **1** |
| Cash, check or free (nothing renews by itself) | 13 |
| Pending, not started | 1 |

## A. Flag says "renews", but it ends (12)

Stripe's stop date equals our end date on all twelve. All eight active cases you named are here, plus four more: Clark Shepherd, Maximus Alexander, Jacob Vann, and Orson Chorba's **new** 12-month plan. All twelve came from the same place: the secure confirmation link (reactivation) passes the commitment end to Stripe and leaves the flag on.

| Member | Plan | Price | Our end date | Stripe's stop | Subscription |
|---|---|---|---|---|---|
| Richard Bishop | Monthly 2 days (Tue/Thu) | $110.00 monthly | 2026-12-03 | 2026-12-03 | `cmw1cfpp50006jafz4nhprz17` |
| Oliver Bishop | Monthly 2 days (Tue/Thu) | $110.00 monthly | 2026-12-03 | 2026-12-03 | `cmw1cgry4000gjafz7b09fkdj` |
| Ashton Warren | Monthly | $110.00 monthly | 2026-12-16 | 2026-12-16 | `cmwjkndzj0001asr061qm7czz` |
| Jameson Bower | Monthly 2 days (Tue/Thu) | $110.00 monthly | 2026-12-17 | 2026-12-17 | `cmwktl0mj000fgipnk1rd01fi` |
| Devlin Bower | Monthly 2 days (Tue/Thu) | $82.50 monthly | 2026-12-17 | 2026-12-17 | `cmwktm5wu0004125vmtywy752` |
| Colton Stickel | Monthly 2 days (Tue/Thu) | $110.00 monthly | 2026-12-17 | 2026-12-17 | `cmwtx3z3z00052zh2iks3yka9` |
| Demir Bajracharya | Upfront | $250.00 quarterly | 2026-12-22 | 2026-12-22 | `cmuensa5a0006al4agmtmeb8r` |
| James Bossert | 3 months | $90.00 monthly | 2027-01-01 | 2027-01-01 | `cmupl2huo0004zxfgipr2u61e` |
| Clark Shepherd | 3 months | $90.00 monthly | 2027-02-19 | 2027-02-19 | `cmwmsx1ep000gbr9l0jrhbg6u` |
| Maximus Alexander | 12 months | $150.00 monthly | 2027-08-09 | 2027-08-09 | `cmsrxr8y60001khffrj22x4ar` |
| Jacob Vann | 1 year | $1,500.00 yearly | 2027-08-13 | 2027-08-13 | `cmsst3c3k0004idkgjic8urjr` |
| Orson Chorba (new plan) | 12 months | $150.00 monthly | 2027-11-25 | 2027-11-25 | `cmwvdt519000dzen6p3um1p2c` |

Before you correct these, it is worth asking whether the families were told their membership **ends**. The confirmation link offered auto-renew on. If you want any of them to keep going, the fix is in the Membership panel (turn auto-renew on), not in this SQL.

```sql
BEGIN;

UPDATE member_subscriptions
SET "autoRenew" = false, "updatedAt" = now()
WHERE "autoRenew" = true
  AND status = 'active'
  AND (id, "endDate"::date) IN (
    ('cmw1cfpp50006jafz4nhprz17', DATE '2026-12-03'),
    ('cmw1cgry4000gjafz7b09fkdj', DATE '2026-12-03'),
    ('cmwjkndzj0001asr061qm7czz', DATE '2026-12-16'),
    ('cmwktl0mj000fgipnk1rd01fi', DATE '2026-12-17'),
    ('cmwktm5wu0004125vmtywy752', DATE '2026-12-17'),
    ('cmwtx3z3z00052zh2iks3yka9', DATE '2026-12-17'),
    ('cmuensa5a0006al4agmtmeb8r', DATE '2026-12-22'),
    ('cmupl2huo0004zxfgipr2u61e', DATE '2027-01-01'),
    ('cmwmsx1ep000gbr9l0jrhbg6u', DATE '2027-02-19'),
    ('cmsrxr8y60001khffrj22x4ar', DATE '2027-08-09'),
    ('cmsst3c3k0004idkgjic8urjr', DATE '2027-08-13'),
    ('cmwvdt519000dzen6p3um1p2c', DATE '2027-11-25')
  );
-- Must say UPDATE 12. Anything else: ROLLBACK and look again.

COMMIT;
```

It changes our flag only. It does not touch Stripe, and it charges and cancels nobody. The end date is checked in the WHERE, so a row somebody has changed since is skipped. Once the flag is right, the family can turn auto-renew back on from their own profile. Until then their switch shows "Off" and says to ask the club.

## B. Flag says "doesn't renew", but it will (1)

| Member | Price | Our end date | Stripe's stop | Next charge | Subscription |
|---|---|---|---|---|---|
| Logan Sheriff | $160.00 monthly | none | none | 2026-12-24 | `cmug3zmit000p740ist1leaof` |

**Decide first which one is right.** If Logan's family asked to stop, the flag is right and Stripe has to be told. That is not a flag fix: use the Membership panel's auto-renew switch, which tells Stripe. If they mean to continue, correct the flag:

```sql
BEGIN;

UPDATE member_subscriptions
SET "autoRenew" = true, "updatedAt" = now()
WHERE id = 'cmug3zmit000p740ist1leaof'
  AND status = 'active'
  AND "autoRenew" = false
  AND "endDate" IS NULL;
-- Must say UPDATE 1.

COMMIT;
```

## C. Flag is right, our end date is wrong (1)

| Member | Price | Our end date | Stripe's stop | Subscription |
|---|---|---|---|---|
| Titus Hall | $1,500.00 yearly | 2027-07-14 | none | `cmrl6h22a000111uzqfh0plio` |

The flag says "renews", and Stripe **will** renew him. The end date was typed into the assign form in July and never reached Stripe. The flag needs no correction, so there is no SQL here. If he is meant to stop on 2027-07-14, turn auto-renew off in the Membership panel, which tells Stripe. The screens now say "Renews".

## Not active, so not corrected

Orson Chorba's **July** plan (`cmrjbewg20001ef454ppb145x`) ended on 2026-11-23 with the flag still on. It is over, so the flag decides nothing. It now reads "Ended Nov 23".

## Not mismatches

- **12 cash, check or free memberships with the flag off.** Two have an end date and stop on it (Riley and Adelynn Bergen). Ten have none and continue when they pay. They read "renews when paid".
- **Aylen Grubusic** (cash, flag on, no end date, paid through 2026-11-12). Nothing charges cash by itself, so it reads "renews when paid".
- **vancen small** (pending). Not started yet.
