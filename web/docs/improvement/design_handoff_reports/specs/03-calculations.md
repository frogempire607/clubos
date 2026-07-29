# 03 — Calculations

Every formula the UI displays is defined here. Where the UI shows a formula to the user, the string comes from the API (`specs/02`), not from the client — one source of truth.

## Double counting — the rule that matters most

A single dollar can appear in the system up to three times:

1. the Stripe charge (`Transaction`, `paymentSource: "STRIPE"`),
2. the Stripe payout batch,
3. the bank deposit of that payout in a connected account.

**Revenue counts the charge. Cash counts the bank balance. Nothing counts the payout twice.**

Implementation:

- Revenue, P&L income and unit economics read `Transaction` only. Bank transactions never contribute to revenue.
- Cash-on-hand reads bank balances (authoritative) plus Stripe balance still in transit (`PayoutMatch` rows with no `bankTransactionId`).
- A bank credit that matches a Stripe payout is tagged and excluded from the cash-flow *operating inflows* line — it is already represented by the underlying charges. Show it in the excluded section with its count and amount.
- Matching heuristic: same amount within ±$0.01, bank posting date within 5 days of the payout's `arrival_date`, and the description contains the Stripe descriptor. Store the result in `PayoutMatch`. Unmatched payouts older than 10 days raise a reliability warning, not a silent adjustment.
- Refunds reduce revenue in the period the refund settled, not the period of the original charge. Show refunds as their own P&L line, never netted invisibly.
- Processing fees are a direct cost, never a reduction of gross revenue. Gross revenue is gross. Use `stripeFeeAmount` from balance transactions — `financialReports.ts` already does this and counts rows missing fee data. Surface that count.

**Transfers between the club's own accounts are neither income nor expense.** Detect: a debit and a credit of the same amount within 3 days across two connected accounts of the same club. Exclude both from P&L. Show in cash flow under "Excluded".

## Financial snapshot

```
netPosition       = totalInflows − totalOutflows        (operating only; excludes transfers, loans, owner draws)
totalInflows      = Σ succeeded, non-void Transaction.amount + Σ Donation.amount in range
totalOutflows     = Σ Expense.amount + payroll + contractor payments in range
avgWeeklyBurn     = trailing 3 complete months of outflows ÷ 13
avgMonthlyBurn    = trailing 3 complete months of outflows ÷ 3
avgWeeklyNet      = trailing 3 complete months of net ÷ 13
avgMonthlyNet     = trailing 3 complete months of net ÷ 3
```

Averages always use **complete** periods. If the selected range is partial, the snapshot shows the period's actuals and the averages' own basis label ("Apr–Jun 2026"). Do not annualize a partial month.

Payroll: `computePayrollTotalForRange(clubId, start, end)` plus `ContractorPayment`, exactly as `overview/route.ts` does today. Manual `PAYROLL` expenses add on top — that's deliberate, for off-books payments.

## Cash on hand and runway

```
totalAvailableCash = Σ connected bank balances + Stripe balance in transit
runwayMonths       = totalAvailableCash ÷ avgMonthlyBurn
```

- Available credit, credit-card limits and lines of credit are **never** cash.
- A negative or zero `avgMonthlyBurn` (a profitable month with no spend) returns `runwayMonths: null` with the note "Not applicable — no net burn in this period".
- No bank connection returns `null`, not a computed guess from transaction history.
- Status bands: `healthy` ≥ 6 months, `tight` 3–6, `critical` < 3. Compare against `ReportAlertSetting.RUNWAY_BELOW` when set.
- Always render the basis: "based on average monthly operating expenses over Apr–Jun 2026 ($47,318.44/mo)".

## Recurring revenue

```
MRR  = Σ active recurring subscriptions, normalized monthly
       (annual ÷ 12, quarterly ÷ 3, weekly × 52 ÷ 12, biweekly × 26 ÷ 12)
ARR  = MRR × 12
ARPA = period revenue ÷ active athlete count
ARPM = MRR ÷ active membership count
recurringPercent = recurring revenue in range ÷ total revenue in range
```

MRR excludes `past_due` and `pending` subscriptions. Show those counts separately — the current Reports page already surfaces them.

A plan change is an upgrade if the new normalized monthly amount is higher, a downgrade if lower. Equal amounts are neither and are excluded from both counts.

## Churn

```
membershipChurnRate = memberships lost during period ÷ active memberships at start of period
revenueChurnRate    = MRR lost during period ÷ MRR at start of period
retentionRate       = 1 − membershipChurnRate
```

"Lost" = canceled **or** expired **and** the member did not start another membership within a 14-day grace window.

**Not churn:**
- switching plans (upgrade, downgrade, or lateral),
- a scheduled pause with a defined return date,
- moving between memberships without an inactive gap,
- a seasonal membership ending when a renewal for the next season already exists.

The 14-day grace window is the whole reason plan changes don't inflate churn. Make it a named constant, not a magic number.

```
avgMembershipDurationMonths = mean(end − start) over all completed memberships, historical included
avgLifetimeValue            = total lifetime revenue per member, averaged over members with ≥1 completed membership
trialToPaidRate             = trials that converted to a paid membership within 30 days ÷ trials started
```

Members with `isHistoricalOnly: true` count in duration and lifetime value. They never count in active membership counts.

## Unit economics

```
revenuePerAthlete        = period revenue ÷ active athlete count
costPerAthlete           = period total costs ÷ active athlete count
grossProfitPerAthlete    = gross profit ÷ active athlete count
operatingProfitPerAthlete= operating profit ÷ active athlete count
grossMarginPercent       = gross profit ÷ net operating income
operatingMarginPercent   = operating profit ÷ net operating income

contributionMarginPerAthlete = revenuePerAthlete − variableCostPerAthlete
breakEvenAthletes            = ceil(monthlyFixedCosts ÷ contributionMarginPerAthlete)
gapToBreakEven               = currentAthletes − breakEvenAthletes
```

If `contributionMarginPerAthlete` ≤ 0, break-even is unreachable: return `null` and the message "Your variable cost per athlete is higher than your revenue per athlete — every additional athlete currently loses money." Do not divide by a negative and print a nonsense number.

```
CAC = marketing spend in period ÷ new members acquired in period
LTV = avgMonthlyRevenuePerAthlete × avgMembershipDurationMonths × grossMarginPercent
```

Both are estimates and must be labelled. CAC returns `null` when there is no marketing spend recorded. Add a caveat whenever new members lack an acquisition source — the number is directionally useful but not attributable.

## Profit & loss

Cash basis: recognise on settlement date (`txDate ?? createdAt`, matching `txDateWhere` in `financialReports.ts`).

Accrual view: recognise ratably across the purchase's service span. Daily proration, not monthly — a camp that runs Jul 28 – Aug 3 splits 4/7 into July. Purchases with no span fall back to cash and increment `unsupportedPurchaseCount`, which the UI reports.

Partial periods:
- monthly — `today < last day of month` for the current month,
- weekly — fewer than 7 elapsed days in the week.

Partial columns are visually marked, excluded from rolling averages, and never used as a comparison base.

Line ordering follows the design exactly: Income → Direct costs → Gross profit → Operating expenses → Net profit → Profit margin. Do not reorder alphabetically.

## Cash flow

```
endingCash = beginningCash + cashReceived − cashSpent + investing + financing
```

Classification:
- **Operating** — memberships, events, camps, privates, merch, refunds, payroll, rent, all normal expenses.
- **Investing** — equipment and property purchases and sales above the club's capitalization threshold (default $2,500; make it configurable).
- **Financing** — loan proceeds, loan payments, owner contributions, owner distributions.
- **Excluded** — account transfers, matched Stripe payouts.

Loan payments split principal (financing) from interest (operating expense) when the schedule is known. When it isn't, put the whole payment in financing and note it.

## Forecasts

```
expectedMembershipRevenue = Σ active subscriptions billing in the forecast window
upcomingPayroll           = next scheduled runs from the payroll module
upcomingRecurringExpenses = vendor charges seen in ≥3 of the last 4 months, at their median amount
expectedStripePayouts     = Stripe balance in transit
projectedMonthEndCash     = current cash + expected inflows − expected outflows
```

Require ≥3 complete months of history. Below that, return `null` and hide the section. Every forecast states its inputs.

## Reliability states

| State | Trigger |
| --- | --- |
| `COMPLETE` | Source synced within 24h and no open issues |
| `MISSING_BANK_CONNECTION` | Zero connected bank accounts |
| `AWAITING_CATEGORIZATION` | ≥1 uncategorized transaction in range |
| `HISTORICAL_DATA_INCOMPLETE` | Any `MemberHistoricalRecord.dataCompleteness` has a false field in range |
| `CASH_DATA_NOT_INCLUDED` | Club records cash elsewhere and has no cash transactions in range |
| `ESTIMATED` | The figure depends on a forecast or an assumption |
| `NEEDS_REVIEW` | Import review queue non-empty, or flagged transactions exist |
| `STALE` | Last sync older than 24h |

Anything other than `COMPLETE` renders the badge, the plain-English detail, and a link straight to the fix.

## Rounding and formatting

Compute in `Decimal`; never accumulate in JS floats. Round only at the boundary, half-up, to 2 dp. Percentages to 1 dp. Percentage-point changes are written as "pp", not "%". Negatives in financial tables are parenthesised — `($1,284.00)` — matching the design.
