# 06 — Test plan

Maps one-to-one onto the Verification section of the brief. Unit tests for the calculation layer, integration tests for the routes, and a handful of end-to-end passes for the import flow. Every case below should fail loudly on a regression.

## P&L calculations

- Monthly P&L over a month with known fixtures matches hand-computed income, direct costs, gross profit, operating expenses and net profit.
- Weekly P&L buckets Monday–Sunday, in the club's timezone, not the server's.
- Gross margin and profit margin round to 1 dp, half-up.
- Line ordering is stable and matches the spec order.
- YTD column equals the sum of its complete months.
- Same-month-last-year column is `null`, not zero, when no data exists for that month.
- Changing basis from cash to accrual changes recognised revenue and reports `unsupportedPurchaseCount`.
- A purchase with no service span is recognised on a cash basis under both settings and is counted as unsupported.
- Daily proration: a camp spanning Jul 28 – Aug 3 puts 4/7 in July.

## Partial periods

- Current month before the last day is flagged `isPartialPeriod` with the correct day count.
- Current week with fewer than 7 elapsed days is flagged.
- Partial columns are excluded from the 4-week rolling average.
- A partial period is never used as a comparison base.
- Monthly averages use only complete months even when the selected range is partial.
- A complete month queried on its last day at 23:59 club time is not flagged partial.

## Stripe, fees and payouts

- A Stripe charge counts once in revenue.
- The bank deposit of that charge's payout does not add to revenue.
- The payout appears in cash flow's excluded section with the right count and amount.
- A payout with no matching bank credit after 10 days raises a reliability warning and is not silently adjusted.
- Processing fees appear as a direct cost, never as reduced gross revenue.
- Fees come from balance transactions; rows with `stripeFeeAmount == null` are counted and surfaced.
- Cash on hand includes Stripe balance in transit exactly once.

## Refunds

- A refund reduces revenue in the period it settled, not the original charge's period.
- Refunds appear as their own P&L line.
- A full refund of a prior-period charge produces negative revenue for the current period without corrupting the prior period's closed figures.
- Refund rate = refunds ÷ gross, and triggers the alert above its threshold.

## Bank transfers and equity

- A matched debit/credit pair between two connected club accounts is excluded from both income and expenses.
- The pair appears in cash flow's excluded section.
- A transfer to an unconnected external account is **not** treated as a transfer.
- Owner contributions and distributions are financing, never income or expense.
- Loan proceeds are financing inflows; loan payments are financing outflows.
- A loan payment with a known schedule splits interest into operating expenses.
- `reports.owner_equity` denial removes equity lines and does not leak them via a total.

## Cash and offline payments

- Cash revenue appears in totals and in the cash/offline P&L line.
- A club with no cash transactions in range reports `CASH_DATA_NOT_INCLUDED` rather than implying zero.
- Comp/free records contribute $0 revenue and do not distort ARPA.

## Churn

- Churn = lost ÷ starting active, to the stated precision.
- An upgrade does not count as churn.
- A downgrade does not count as churn.
- A lateral plan change does not count as churn.
- A cancel followed by a new membership 10 days later does not count as churn (inside the grace window).
- A cancel followed by a new membership 20 days later **does** count as churn.
- A scheduled pause with a return date does not count as churn.
- An expiry with a renewal already booked for the next season does not count as churn.
- Revenue churn uses MRR lost ÷ starting MRR, not member counts.
- Retention = 1 − churn, always.
- Zero starting memberships returns `null`, not a division-by-zero or `Infinity`.
- The `formula` object returned by the API matches the computed result.

## Historical imports

- Importing the same members file twice creates no duplicate members.
- Importing the same transactions file twice creates no duplicate transactions (unique constraint path).
- Rows with no external transaction ID dedupe on the composite fingerprint.
- External ID match auto-matches; a similar name never does.
- An external ID matching two members goes to review, not to a merge.
- Contradicting HIGH signals go to review.
- A phone number matching a staff record goes to review at LOW confidence.
- Each of the five review outcomes writes the right records and the right `ImportRow`.
- Merge never overwrites a non-empty native field.
- Imported members trigger no email, no invite, no billing, no campaign membership.
- Undecided rows survive commit as `PENDING_REVIEW` and the rest of the batch still commits.
- Rollback within 30 days removes created records, detaches history, and reverses merges.
- Rollback leaves alone any created record that has gained activity, and reports it.
- Rollback after 30 days is refused.
- Rollback is refused for non-owners.
- The audit log has one row per CSV line, including excluded ones.
- `errors.csv` contains the original rows verbatim plus the error column.
- A 50,000-row file completes; a 50,001-row file is rejected with a clear message.

## Fixed vs variable classification

- Default classification derives from the category.
- An owner override changes the split everywhere it appears.
- An override survives a category rename.
- Fixed + variable equals total outflows, to the cent.
- Percent-of-revenue uses the same period's revenue.

## Break-even and unit economics

- Break-even = ceil(fixed ÷ contribution margin) against fixtures.
- A non-positive contribution margin returns `null` and the explanatory message.
- Gap = current athletes − break-even, signed correctly in both directions.
- Zero athletes returns `null` for every per-athlete figure, not `NaN`.
- CAC returns `null` with no marketing spend.
- LTV:CAC returns `null` when either input is `null`.
- Every estimated field carries its estimate flag.

## Permissions

- Each of the ten permission keys is enforced server-side.
- A staff member with `reports.financials` but not `reports.payroll` gets a P&L with payroll nulled *and* the affected totals nulled.
- A coach sees only their own revenue on `groupBy=coach`.
- `reports.by_coach` denial returns 403.
- Tier gating still returns `UPGRADE_REQUIRED` with the existing body shape.
- Hidden tabs are not reachable by direct URL.

## Missing and incomplete data

- No bank connection: runway is `null` and the UI says connect a bank, never "0 months".
- Zero-burn month: runway is `null` with the not-applicable note.
- Uncategorized transactions produce `AWAITING_CATEGORIZATION` with a working deep link.
- Incomplete historical data produces `HISTORICAL_DATA_INCOMPLETE` naming the specific gap.
- Sync older than 24h produces `STALE`.
- Fewer than 3 complete months returns `forecast: null` and the section is hidden.
- An empty club renders every section's empty state without throwing.
- Every reliability warning's `href` resolves to a real route.

## Mobile and tablet

- Tab bar scrolls horizontally at 375px with the active tab visible on mount.
- KPI cards go 4 → 2 → 1 at the right breakpoints.
- Every wide table scrolls horizontally with a sticky first column.
- No horizontal page scroll at 375, 414 or 768 px.
- No number is clipped or ellipsed without a way to see it in full.
- Every interactive target is ≥ 44×44 on touch.
- Reliability and alert strips remain visible and legible at 375px.
- Sticky table headers do not collide with the mobile topbars.
- Tapping a figure opens the drill-through sheet.

## Regression guard

- `/dashboard/financials` renders unchanged and its API responses are byte-identical before and after this work. Snapshot-test it — Reports must not disturb it.
