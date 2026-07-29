# AthletixOS — Coordinated Product Improvement

## 0. Mission

This is **one coordinated product improvement**, not a list of unrelated feature requests.

**Outcome we are building toward:** AthletixOS should be the easiest and most complete operating system for youth sports organizations — owners manage members, finances, communication, events, and day-to-day operations from one connected platform.

Every change must move the platform toward *polished, intuitive, scalable, production-ready* while maintaining **backward compatibility with existing customer data**.

### How to think about each request
- Think beyond the individual feature — consider how it integrates with the rest of the platform.
- Prefer reusable architecture over one-off solutions.
- Prefer the simpler workflow when it accomplishes the same business goal.
- Reuse existing components and services wherever possible.
- **If you identify a significantly better implementation than what is described here, explain why before implementing it.** Do not blindly implement every request if it introduces unnecessary technical debt — explain the tradeoffs and implement the cleaner solution.

---

## 1. Design Handoffs (source of truth)

Two approved Claude Design handoff files are provided:

1. **Members handoff** — source of truth for all UI/UX for Members, Member Profiles, Relationships, Migration, and any connected flows.
2. **Reports handoff** — source of truth for the Reports page.

Follow the approved designs unless there is a technical limitation or a substantially better solution. If you deviate, say so and explain why.

---

## 2. Before Writing Any Code

Complete this discovery pass first and report findings before implementation.

**2.1 — Review the existing implementation for every affected feature.**

**2.2 — Map how the current architecture works across:**
- Database schema
- API routes
- Stripe
- Plaid
- Reports
- Communications
- Members
- Family relationships
- Permissions
- Migrations

**2.3 — Identify opportunities to simplify existing logic** instead of layering new code on old code.

**2.4 — Identify anything required:**
- Database migrations
- Backfills
- New indexes
- Permission changes
- API updates

**2.5 — Classify each issue** as UI-only vs. backend/schema change.

**2.6 — Document risky assumptions.**

**2.7 — Produce a phased implementation plan** that keeps existing production data compatible.

**Preserve existing production data unless explicitly instructed otherwise.**

---

## 3. Standards That Apply to Every Section

For each area below:
- Understand the underlying business problem first.
- Improve the entire workflow, not just the specific UI.
- Desktop, tablet, and mobile must be equally polished.
- Maintain consistency with the rest of AthletixOS.
- Avoid duplicate business logic.
- Respect all permission levels.
- Maintain full auditability for financial and member-related actions.
- Every important action needs loading, success, warning, empty, and error states.
- Maintain accessibility and keyboard navigation.
- Add regression tests for new functionality where appropriate.

---

## 4. Implementation Order

Treat each phase as a complete product area before moving to the next.

| Phase | Area |
|---|---|
| 1 | Owner Financials |
| 2 | Reports |
| 3 | Communications & Email |
| 4 | Client & Family Accounts |
| 5 | Event Registration Confirmation |
| 6 | Safety, Data Integrity & Testing |

---

# PHASE 1 — Owner Financials

**Goal:** An owner can see exactly where every dollar came from and went, on any device, without mentally untangling Stripe from cash from bank activity.

## 1A. Separate Stripe and Cash/Offline Transactions

**Problem:** The Stripe section under Financials currently mixes in non-Stripe money.

**The Stripe transaction list must only show transactions that actually came through Stripe.** Do not mix in:
- Cash payments
- Checks
- Manual payments
- Bank transfers that did not use Stripe
- Other offline payment methods

**Add a separate Cash and Offline Payments page or tab**, covering:
- Cash
- Check
- Manual payment
- External card payment
- Bank transfer
- Other offline payment methods

Each transaction must clearly show:
- Date
- Client or payer
- Athlete, if different from payer
- Item purchased
- Payment method
- Amount
- Staff member who recorded it
- Notes
- Receipt status
- Refund or reversal status

**Data integrity:** historical payment records keep their original source and are never relabeled as Stripe transactions.

## 1B. Bank Transaction Date Filters

**Problem:** The Bank page appears to show only ~30 days of Plaid transactions.

**First diagnose the actual cause.** Determine whether the limit comes from:
- The user interface
- The API request
- Plaid pagination
- Plaid transaction-sync configuration
- Database storage
- A scheduled synchronization job

**Then add date-range filters:**
- 30 Days
- 60 Days
- 90 Days
- Year to Date
- All Time
- Custom Range

"All Time" means all bank transaction history AthletixOS has successfully imported and stored. If Plaid cannot retrieve the account's complete lifetime, **clearly communicate the earliest available transaction date**.

Use pagination or incremental loading so large histories stay usable.

## 1C. Money Out and Expense Matching

**Goal:** A club owner can review and categorize outgoing money in a workflow inspired by QuickBooks but simple enough for a wrestling club or gym.

Money Out should be automatically detected from debit and outgoing bank transactions.

Each outgoing bank transaction must be able to be:
- Categorized
- Marked as reviewed
- Matched to an uploaded receipt
- Matched to payroll
- Matched to a vendor
- Matched to a refund
- Matched to a Stripe fee or payout adjustment
- Split across multiple categories
- Excluded from tax reporting
- Marked as a transfer between accounts
- Marked as personal or non-business, with proper permissions and warnings

**Suggested statuses:** Needs Review · Suggested Match · Matched · Categorized · Excluded · Duplicate · Transfer

**Matching logic:** use transaction amount, date, vendor name, payroll records, receipts, and existing system records to suggest matches.

**Never auto-finalize a match** unless it is highly reliable and safe. Owners must be able to approve, reject, or change every suggestion.

## 1D. Tax Summary

**Goal:** An owner gets an accurate organizational picture of taxable profit with no double counting.

The Tax Summary should primarily use **bank transaction data**, because clubs receive and spend money outside Stripe.

**Income should consider:**
- Stripe deposits and payments
- Checks deposited into connected bank accounts
- ACH deposits
- External payment processors
- Other business income visible in bank transactions

**Expenses** come from categorized outgoing bank transactions.

Do **not** include physical cash payments in the bank-based Tax Summary unless the owner separately recorded and categorized them as cash income inside AthletixOS.

**Avoid double counting:**
- A Stripe customer payment must not count once as a Stripe transaction and again when the payout hits the bank.
- Transfers between the club's own accounts are neither income nor expense.
- Refunds reduce the correct income category.
- Stripe fees are treated separately from gross revenue.
- Loan deposits do not automatically count as income.
- Owner contributions do not automatically count as revenue.
- Owner distributions do not automatically count as business expenses.

**The Tax Summary must clearly show:**
- Gross income
- Refunds
- Processing fees
- Net income
- Categorized expenses
- Uncategorized transactions
- Transfers
- Excluded transactions
- Cash income recorded separately
- Estimated taxable profit

Include warnings that this is an organizational summary, not a substitute for professional tax advice.

## 1E. Mobile and Tablet Financials

**Goal:** The Stripe and Bank pages are fully usable on a phone.

- Tables must not be cut off.
- Horizontal scrolling must be available when a full table is necessary.
- Important information should stay visible without horizontal scrolling where possible.
- Filters must remain accessible.
- Action menus must not render off-screen.
- Sticky columns or card layouts may be used where appropriate.
- Test common phone, tablet, laptop, and desktop widths.
- Avoid duplicate mobile-only and desktop-only actions that perform the same function inconsistently.

---

# PHASE 2 — Reports

**Goal:** The Reports page gives an owner complete historical visibility, not just a recent window.

**Follow the approved Reports design handoff as the source of truth.**

Required additions:
- **All-time transactions** — full transaction history, not a limited recent range.
- **All-time members** — full member history, including historical/inactive members.

Apply the same standards as Phase 1: date-range filtering, pagination or incremental loading for large datasets, permission-aware data, mobile and tablet layouts, and loading/empty/error states.

> **Note:** this section is thinner than the others in the original brief. Before implementing, review the Reports design handoff and report back with the full list of reports, metrics, filters, and export options it specifies, plus anything you recommend adding.

---

# PHASE 3 — Communications and Email

**Goal:** An owner or authorized staff member can create a professional email and send it to exactly the right group of members — without HTML knowledge, without duplicate sends, and without leaking one family's information to another.

Two entry points must be supported:
- **Targeted messages** from the Members page
- **Advanced campaigns** from the Communications page

## 3A. Email Members Directly From the Members Page

Owners and authorized staff can select members from the Members List and send a custom email.

**Selection must support:**
- One member
- Multiple members
- All members on the current page
- All members matching the current filters
- Clearing the selection
- Reviewing recipients before sending

**Filterable/emailable groups include:**
- Active members
- Inactive members
- Prospects
- Not invited
- Invited
- Migration in progress
- Completed migration
- Members with a specific membership
- Members in a specific program
- Members assigned to a specific coach
- Members within an age group
- Parents or guardians
- Athletes
- Members with unpaid balances
- Members attending a specific class or event
- Members who have not attended recently
- Members whose memberships are expiring
- Custom manually selected groups

Add a clear bulk action: **Email Selected Members**

**Before opening the composer, show:**
- Number of selected member profiles
- Number of unique email addresses
- Members without an email address
- Duplicate or shared family email addresses
- Any recipients excluded for permissions, unsubscribes, or invalid addresses

**Household logic:** one parent email may manage multiple children. Do not send duplicate copies to the same address unless the sender deliberately chooses one message per athlete.

**Sender chooses between:**
- One email per unique household email
- One email per selected member
- One email per athlete's primary contact

Clearly preview how many actual emails will be sent.

## 3B. Rich Email Composer

A simple visual editor requiring **no HTML knowledge**, on both the Communications page and Members page.

**Content blocks:**
- Subject line
- Preview text
- Headings
- Subheadings
- Paragraph text
- Bold / italic / underlined text
- Bulleted lists
- Numbered lists
- Buttons
- Clickable links
- Images
- Club logo
- Dividers
- Spacing
- Contact information
- Social media links
- Call-to-action sections

**Editor capabilities:**
- Drag-and-drop or easy image uploads
- Image resizing
- Image alignment
- Alternative text for accessibility
- Link editing
- Undo and redo
- Desktop preview
- Mobile preview
- Test email
- Save as draft
- Duplicate message
- Save as template
- Schedule for later
- Send now

**Never allow unsafe HTML, scripts, or externally injected code.**

## 3C. Email Templates

Reusable templates for common club communication:
- General Announcement
- Practice Cancellation
- Schedule Change
- Event Registration
- Camp Promotion
- Membership Expiration
- Payment Reminder
- Migration Invitation
- Welcome Email
- Free Trial Follow-Up
- Weather Closure
- Tournament Information
- Fundraising Announcement
- Custom Blank Template

**Owners can:** create, edit, duplicate, and archive templates; set a default club header and footer; auto-insert club logo and contact information.

Staff access to templates follows communication permissions.

## 3D. Dynamic Recipient Groups

The Communications page lets owners and authorized staff build recipient groups from filters:
- Membership status
- Membership type
- Program
- Attendance
- Age
- Graduation year
- Location
- Coach
- Migration status
- Invitation status
- Payment status
- Event registration
- Class registration
- Relationship type
- Account role
- Tags
- Custom selections

**Filters must combine**, e.g.:
- Active middle-school members who have not attended in 14 days
- Parents of athletes registered for a specific event
- Members whose memberships expire within 30 days
- Invited members who have not completed migration
- Athletes enrolled in a specific program at a specific location

Show the estimated recipient count as filters are added. Allow saving a filtered audience as a reusable group. **Saved dynamic groups update automatically** as members start or stop meeting the criteria.

## 3E. Family and Relationship-Aware Communication

The system must understand family relationships and account management.

**Sender chooses the target:**
- The athlete
- The primary parent or guardian
- All authorized guardians
- The payer
- The account holder
- All linked family contacts
- One email per household
- Every selected profile individually

**For minors, default to the authorized guardian** unless club settings and permissions allow direct athlete communication.

Clearly show which recipient address was selected for each member.

## 3F. Personalization

Safe personalization fields:
- Member first name
- Athlete first name
- Parent or guardian first name
- Membership name
- Membership expiration date
- Outstanding balance
- Event name
- Class name
- Coach name
- Club name
- Club contact information
- Registration link
- Payment link
- Migration link

Example: `Hi {{guardian_first_name}}, Kellen's membership expires on {{membership_end_date}}.`

- Warn when a personalization field is unavailable for some recipients.
- Allow previewing the message as a specific recipient before sending.
- **Never expose another family's information through incorrect personalization.**

## 3G. Communication History

**Each member profile shows:**
- Email subject
- Date and time sent
- Sender
- Recipient address
- Delivery status
- Open status, when available
- Link-click status, when available
- Failed or bounced status
- Unsubscribed status
- Related campaign
- Related event or membership
- Message preview

**From the member profile, authorized users can:** view the full message, resend it, send a new email, copy the message, and see why delivery failed.

**The Communications page shows campaign-level results:**
- Intended recipients
- Emails sent
- Delivered
- Opened
- Clicked
- Bounced
- Failed
- Unsubscribed
- Skipped because no email was available

**Never claim an email was opened when tracking is unavailable or blocked.**

## 3H. Drafts, Scheduling, and Approval

Communications can be: saved as drafts · scheduled for a future date and time · canceled before sending · duplicated · sent immediately · submitted for owner approval.

Consider an optional approval workflow where certain staff roles draft emails but an owner or administrator approves the final send.

Scheduled messages use the club's timezone and clearly display the scheduled time.

**Prevent duplicate sends** caused by retries, page refreshes, job restarts, or repeated clicks.

## 3I. Unsubscribes and Required Messages

Support unsubscribe preferences for promotional and general marketing messages.

**Do not allow unsubscribing from essential transactional messages** where legally and operationally appropriate:
- Payment receipts
- Password-reset emails
- Event registration confirmations
- Membership purchase confirmations
- Account-security notices

**Clearly distinguish:** marketing emails · general club announcements · program updates · transactional emails · emergency or safety notices.

Honor unsubscribe preferences and keep an audit log of preference changes.

## 3J. Attachments, Links, and Images

Supported content: JPEG · PNG · PDF · registration links · calendar links · payment links · website links · social media links.

- Apply reasonable file-size and file-type limits.
- Scan or validate uploaded files where supported.
- **Never allow executable files or unsafe attachments.**
- For large files, prefer secure hosted links over oversized attachments.

## 3K. Deliverability and Sending Safeguards

**Pre-send checks for:**
- Empty subject
- Empty message
- Invalid email addresses
- Duplicate addresses
- Recipients without email addresses
- Unsubscribed recipients
- Excessively large images
- Broken personalization fields
- Missing sender identity
- Missing club contact information

**Final review screen shows:** subject · sender · reply-to address · recipient count · excluded recipient count · message preview · scheduled time · whether tracking is enabled.

Use idempotency so the same campaign cannot accidentally send twice. Large campaigns run through a reliable background job with progress and failure reporting.

## 3L. Permissions

Add or verify permissions for:
- View communications
- Create drafts
- Send individual emails
- Send bulk emails
- Use marketing audiences
- Manage templates
- Upload images
- Schedule campaigns
- View analytics
- Approve campaigns
- Manage unsubscribe settings

Owners have full access. Staff access only what their role explicitly allows. **Example:** a coach may email athletes assigned to their program without seeing the entire club's member list or financial information.

## 3M. Mobile and Tablet

- Member selection stays usable.
- Recipient count stays visible.
- Composer toolbar does not run off-screen.
- Images are easy to upload and resize.
- Desktop and mobile previews are accessible.
- Draft and send actions stay visible.
- Tables scroll where necessary.
- Sending confirmation dialogs fit within the screen.
- **The editor must not lose content when the device rotates or the page refreshes.**

## 3N. Testing — Communications

Cover:
- Emailing one member
- Emailing multiple members
- Emailing all filtered members
- Shared guardian emails
- Multiple children under one parent
- Unique-household vs. per-athlete delivery
- Missing email addresses
- Invalid email addresses
- Unsubscribed recipients
- Dynamic groups
- Personalization fields
- Image uploads
- Links and buttons
- Draft saving
- Scheduled sending
- Approval flow
- Duplicate-send prevention
- Delivery failures
- Communication history
- Staff permissions
- Coach-restricted audiences
- Mobile and tablet layouts

**Document at the end of this phase:** email provider and sending flow · database/schema changes · background jobs added · email tracking limitations · file-upload limitations · new permissions · required environment variables · manual testing steps · deployment order · rollback plan.

---

# PHASE 4 — Client and Family Accounts

**Goal:** One parent login can cleanly manage multiple athletes — including buying a membership and assigning it to the right kid — without duplicate records or broken relationships.

## 4A. Membership Assignment Between Linked Family Members

**Problem:** A parent purchases a membership under their own profile and cannot assign it to a linked child.

**Real case:** Michael Lister created his own profile and purchased a membership under it. His son Kellen is already linked to his account. The membership cannot currently be moved or assigned to Kellen.

Both authorized staff **and** the client account holder should be able to transfer or assign an eligible unused membership to a linked family member.

**The transfer flow must:**
- Show the current membership owner
- Show eligible linked family members
- Explain whether the transfer is allowed
- Confirm the new athlete receiving the membership
- Preserve payer and payment information
- Preserve the original transaction and receipt
- Record who performed the transfer
- Record the date and reason
- Prevent accidental duplicate memberships
- Prevent transferring a membership after usage when club rules do not allow it

**Do not rewrite payment ownership.** The payer stays Michael while the membership beneficiary becomes Kellen.

**Clearly distinguish these roles:** payer · account holder · membership owner · athlete using the membership · guardian or manager.

Add confirmation messaging before and after the transfer.

## 4B. Same-Email Family Onboarding

**Problem:** Multiple family members onboarded under the same guardian email do not link correctly.

**Real case:** Michael's second son, Cameron, was onboarded using Michael's email. The account could not be linked correctly. A staff-created relationship was added, but Cameron still did not appear on Michael's profile.

**A parent or guardian must be able to manage multiple athletes under one email address. Do not treat a shared email as proof of duplicate records.**

The data model and UI must support:
- One login managing multiple athlete profiles
- Separate athlete records
- Shared guardian email
- Individual birthdays and profile information
- Separate memberships
- Separate attendance
- Separate bookings
- Separate waivers when required
- Shared or separate payment methods, based on permissions

When staff adds a relationship, the linked person must **immediately** appear in the Family and Relationships section of both profiles. Fix any stale-cache, query, authorization, or relationship-direction issues preventing this.

## 4C. Relationship Visibility and Permissions

**For every linked relationship, show:**
- Person's name
- Profile image
- Relationship type
- Who manages whom
- Who can book
- Who can pay
- Who can sign waivers
- Who receives emails
- Relationship status
- Date linked

**Relationship actions:** View Profile · Edit Relationship · Confirm Relationship · Remove Relationship · Transfer Management · Assign Membership · Book for This Athlete

**Not every staff role should automatically be able to edit family or financial relationships.** Respect staff permissions throughout.

## 4D. Testing — Family Accounts

Cover:
- Parent with one child
- Parent with multiple children
- Multiple children sharing one guardian email
- Child linked after onboarding
- Child linked before onboarding
- Membership purchased by parent and assigned to child
- Membership transferred by staff
- Membership transferred by client
- Relationship removed
- Duplicate relationship attempt
- Reciprocal profile visibility
- Guardian permissions
- Staff permissions
- Unused vs. already-used membership transfer rules

---

# PHASE 5 — Event Registration Confirmation

**Goal:** Every registrant — member or not, paid or free — gets unambiguous proof that they are registered, on screen and by email, exactly once.

**Applies to:** existing members · non-members · logged-in users · guest registrants · paid registrations · free registrations · registrations using a discount code · registrations made by a parent for a child.

**The confirmation page must show:**
- "You're registered" success message
- Event name
- Registered athlete or attendee
- Date and time
- Location
- Amount paid
- Payment status
- Discount applied
- Registration confirmation number
- Add-to-calendar option
- View registration option
- Return to schedule or dashboard
- Contact information for questions

**Correctness rules:**
- **Never display the success page unless registration creation actually succeeded.**
- For Stripe registrations, confirm the correct payment state before showing a final paid confirmation.
- Properly handle processing, failed, canceled, free, and offline-payment states.

**Confirmation email must include:**
- Event details
- Athlete or attendee name
- Payer name, if different
- Amount paid
- Discount
- Receipt or transaction reference
- Cancellation or refund policy
- Calendar link
- Club contact information

**Prevent duplicate confirmation emails** when webhooks or retries run more than once.

---

# PHASE 6 — Safety, Data Integrity, and Verification

**Goal:** Nothing in this release corrupts financial history, loses a member record, or exposes one family to another.

## 6A. Implementation Requirements

- Use database transactions where multiple related records must change together.
- Use idempotency for imports, payment-related actions, event confirmations, and email sending.
- Add audit logs for financial categorization, membership transfers, relationship changes, imports, merges, and staff actions.
- Preserve historical transaction records.
- Do not silently delete or merge member records.
- Do not double count Stripe payments and bank deposits.
- Do not expose one family's information to another family.
- Respect owner, administrator, staff, coach, and client permissions.
- Add loading, empty, success, warning, and error states.
- Maintain accessibility and keyboard navigation.
- Verify desktop, tablet, and mobile layouts.

## 6B. Testing Requirements

- Run TypeScript checks.
- Run linting.
- Run the production build.
- Run existing automated tests.
- Add targeted tests for the new behavior.
- Test Stripe test-mode flows.
- Test Plaid sandbox or mocked transaction flows.
- Test CSV imports with duplicate and malformed records.
- Test mobile and tablet layouts.
- Test permission boundaries.

---

## 7. Final Deliverable

When the work is complete, provide:

- Summary of what changed
- Schema and migration changes
- Backfill requirements
- New environment variables, if any
- Tests added
- Tests run and results
- Known limitations
- Manual testing checklist
- Deployment order
- Rollback plan
- Commit hashes
- Any areas that still require design or product approval
