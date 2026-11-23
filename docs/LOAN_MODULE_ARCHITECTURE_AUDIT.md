# Xhaira loan module architecture audit

**Audit stage:** Phase 1, read-only architecture review  
**Scope:** Member lending under `/api/loans` and `/app/loans`; employee-to-employee loans under `/api/finance/loans` are a separate feature.  
**Schema evidence:** Repository migrations and source code. A live database catalog was not available during this review, so deployed-schema parity remains unverified.

## Summary

Xhaira already has member loan products, applications, schedules, guarantor records, approvals/rejections, partial disbursement, repayment, and overdue schedule marking. The app is not an empty module and those paths should be extended in place.

The existing lifecycle is narrower than the requested credit platform. The current member loan flow is member-only, uses a single simple-interest calculation, has no loan-specific fee model, and treats guarantors as applicant-entered member references without consent. No collateral or guarantee reservation model was found.

The most important financial limitation is the posting model. A loan disbursement debits the SACCO cash account and credits the member's deposit account. A repayment debits that member deposit account and credits cash. These entries balance in the deposit ledger, but they do not recognize or reduce a loan receivable, nor separately recognize principal, interest, penalty, or fee income. Current loan repayment updates `loans.total_paid` and schedules separately from the transaction creation, so a posting can succeed while a later loan update fails. This accounting boundary must be addressed before implementing loan-fee collection, receivable accounting, or expanded repayment allocation. Do not bypass the transaction service.

## Audit matrix

| Functionality | Existing implementation | Missing requirements | Proposed additive change | Regression risks |
| --- | --- | --- | --- | --- |
| Loan products | `products` stores loan rate, duration, repayment cycle, amount bounds, and approval flag. Product UI/API are generic across product types. | Fee schedules, duration unit, calculation method, product-specific guarantee/collateral/non-member and disbursement policies. | Add loan-only configuration with safe defaults; retain existing product columns and monthly meaning. | Existing product form validation and product consumers assume `duration` is months. |
| Applications | `applyForLoan` validates active member, member account when supplied, product bounds, group policy and guarantor count; creates loan and schedule. API requires `finance.manage`. | Non-member applicant model, fee status/payment reference, configurable terms snapshot, borrower acceptance for amended terms. | Add nullable relationships/snapshots and states; retain current member application API contract. | Auto-approval path can immediately disburse when an account exists; new fees or acceptance must not accidentally trigger payout. |
| Eligibility | `checkLoanEligibility` checks active member, fixed savings, global max multiplier and active-loan count. The apply path catches eligibility errors and still accepts application; it stores/returns result but does not enforce ineligibility. | Product/org-level rules, available (not gross) balances, non-member eligibility, accepted guarantee/collateral coverage. | Preserve current result shape; make policy enforcement explicit/configurable and server-side. | Blocking applications that currently proceed would change behavior; introduce a compatibility default and explicit policy. |
| Interest/schedule | `calculateLoan` uses simple annual interest `principal × rate × duration/12`, equal installments and cycles. Supported cycles: daily, weekly, biweekly, monthly, quarterly, annually. Schedule dates are generated from current date. | Explicit interest methods, duration units, maturity-date snapshot, date edge-case policy, borrower acceptance after revised terms. | Add a versioned calculation configuration; leave historical schedules untouched. | Existing schedules are regenerated when an approved amount differs; `duration` is treated as months and month-end dates may drift. |
| Guarantors | `loan_guarantors` stores internal member ID, amount, a generic status, response timestamp. Application validates group membership and current `validateGuarantor` checks savings-based capacity and existing amounts. | Consent is not real: applicant supplies IDs and API inserts them; no guarantor-authenticated accept/decline workflow, external guarantors, exact consent audit, release history, percent-based guarantees. | Add identity/consent lifecycle while preserving existing rows as historical, unaccepted records unless evidence says otherwise. | Treating existing `PENDING` records as accepted would create unauthorized liability. Current validation does not subtract held/restricted balances or reserve against concurrent pledges. |
| Guarantee capacity/reservation | Capacity is computed using active ledger balance × global `GUARANTOR.max_guarantee_percentage`, less sums on loans in PENDING/APPROVED/ACTIVE. | Eligible account types, holds/restrictions, reservation records, database concurrency control, withdrawal enforcement, authorized release. | Separate non-financial commitment from optional balance restriction; implement atomic capacity locking and integrate with withdrawal checks. | Current sum counts applicant-entered, unaccepted commitments as guarantees; switching semantics can make capacity appear to increase. |
| Collateral | No member-loan collateral model or workflow found. | Collateral identity, valuation, verification, coverage rules, documents, release history. | Add collateral records and review states independently from accounting postings. | Collateral cannot be represented as a ledger movement; avoid treating pledged value as cash or a deposit. |
| Fees | No loan fee table/service/UI found. Existing centralized transaction fee logic handles SACCO/Xhenvolt/MarzPay charge calculations for payment flows. | Product fee schedules; fixed/percent; min/max; income destination; pre-application/disbursement/mixed methods; paid status and idempotency. | Add versioned per-product fee definitions and per-loan fee assessments; reuse confirmed payment workflow for payment collection. | Confusing provider charges with loan fees; duplicate fee recognition; changing net payout without separate gross/net accounting. |
| Approval/rejection | Approval requires PENDING and supports approved amount up to requested principal, recalculating interest/schedule. Rejection stores reason. Both require `finance.manage`. | Maker-checker separation, explicit reviewer/approver roles, borrower acceptance of changed terms, complete event history. | Add additive event/audit records and retain status-compatible endpoints. | Schedule delete/rebuild on partial approval is destructive to review history; this only affects a not-yet-disbursed pending loan today. |
| Disbursement | Supports full/partial amount up to approved amount; requires member account; creates transaction; updates status and total disbursed. API requires `finance.manage`. | Receivable accounting, net payout/fee split, funding-account choice, non-member destination, authorization/maker-checker, robust idempotency and atomic loan+ledger update. | Extend transaction service with balanced, classified postings and perform loan state + posting in one DB transaction; keep current route as compatibility path. | Existing service releases the DB client before posting and updates loan after transaction; simultaneous requests can exceed remaining approved amount or duplicate payout. Current entries classify cash/deposit movement, not a receivable. |
| Repayment | Active loans only; validates against `total_payable-total_paid`; posts member-account debit and cash credit; applies payment oldest schedule first; records transaction IDs on schedules. | Configurable allocation, principal/interest/penalty accounting, cash/mobile-money repayment choices, early settlement/restructuring, atomic/idempotent posting, arrears breakdown. | Add allocation policy and receivable accounts; preserve current flat payment allocation by explicit legacy default. | Transaction and loan/schedule state are not atomic; concurrent/duplicate repayments can over-apply. No loan-specific idempotency key. |
| Arrears/default/closure | `markOverdueInstallments` marks schedule rows overdue by due date; full payment changes loan to COMPLETED. Status enum includes DEFAULTED/WRITTEN_OFF. | Days overdue, accrued interest, penalties, default/write-off workflows and accounting, closure checks. | Build monitoring on the saved schedule and add explicit approved transitions. | No evidence that job scheduling or default/write-off accounting exists; do not infer status values imply working workflows. |
| Member balances/accounts | Member balance is computed from ledger entries. Transaction service validates tenant-scoped member accounts and currency. Withdrawal validation lives in account-rules engine. | Hold-aware available balance and guarantee restrictions. | Extend shared balance/withdrawal service to include active reservations, without changing total ledger balance. | Updating only loan UI leaves other withdrawal APIs and channels unprotected. |
| Organization accounts/accounting | Shared `createTransaction` enforces balanced debit/credit and writes transaction, entries, and organization account ledger; system cash account is tenant-scoped. Savings interest engine has its own income/expense classifications. | Loan receivable and income account mapping; segregated principal, interest, penalties, fees; audited reversals. | Reuse transaction engine; create organization-controlled account mappings and loan journal allocation. | Loan posting currently implies cash/deposit movement only; adding fees to existing entries would incorrectly classify principal or income. |
| Permissions/tenant isolation | Loan routes use `requirePermission` with `finance.view` or `finance.manage` and `runWithOrganizationContext`; list/detail queries include organization IDs. Migration 956 adds organization IDs, indexes and RLS to tenant tables. | Separate applicant/guarantor/officer/reviewer/approver/disburser/finance roles; verify every future table joins tenant ownership. | Add granular permissions without removing current finance permissions; use org-scoped FKs/RLS and API predicates. | Existing records lack fine-grained actor roles; new tables without migration 956-style policies risk cross-tenant exposure. |
| Notifications | No loan-specific notification calls/workflow found in inspected loan service/API paths. | Application, guarantor invitation/decision, approval, fee status, disbursement and repayment notifications. | Integrate with existing notification service after identifying its delivery guarantees and templates. | Notifications must not be used as proof of consent or payment. |
| MarzPay | Existing collection/disbursement helpers, payment intents, callback/webhook confirmation, settlement verification, and ledger posting are present. Generic payment APIs exist. | No loan-fee linkage found in inspected loan code; need association to assessment/application and idempotent recognition after confirmed payment. | Integrate through current payment-intent lifecycle and metadata/reference; leave provider callbacks and settlement logic intact. | A separate payment flow or marking paid at request-initiation would break confirmation and idempotency guarantees. |
| Reports/UI | `/app/loans` lists and submits member loans; detail page shows terms, totals, actions, guarantors and schedule. Employee-loan page is separate. | Fee preview/status, external guarantor consent, collateral, non-member, flexible units, disbursement details, arrears and loan portfolio accounting reports. | Extend existing pages and add configuration/report screens incrementally. | Current labels hardcode months; dashboard “total disbursed” sums principal for ACTIVE/COMPLETED, not actual partial `disbursed_amount`. |
| Tests | Test directory contains transaction/account ledger, MarzPay collection/disbursement and member validation tests. No loan lifecycle, loan accounting, guarantee, fee, or tenant-loan tests were found. | Mandatory synthetic-tenant lifecycle and concurrency regression coverage from project brief. | Add tests alongside each sub-phase and acceptance suite after financial model exists. | Existing tests do not protect current loan behavior, so regression risk is higher than test inventory suggests. |

## Dependency map

```text
Loan product configuration
  ├─ fee definitions ── fee assessments ── confirmed payment intent (MarzPay) ── fee income posting
  ├─ duration / interest / schedule policy ── application terms snapshot ── approval / revised-term acceptance
  ├─ guarantee policy ── internal/external identity ── authenticated consent ── available capacity
  │                                                        └─ optional reservation ── withdrawal enforcement
  ├─ collateral policy ── collateral record ── independent valuation/review
  └─ borrower eligibility (member or non-member)

Approved contractual loan
  └─ authorized disbursement ── loan receivable + funding source + net borrower payout + fee income
       └─ repayment allocation ── principal recovery + interest/penalty income + schedule/arrears/closure
```

The financial branches depend on chart-of-accounts classifications and atomic/idempotent posting. They must not be implemented by direct balance edits or by changing transaction descriptions alone.

## Protected working behavior

- Existing member loan product fields, product IDs, API response shapes, and monthly-duration interpretation.
- Existing application, approval/rejection, partial-disbursement, schedule, repayment, and receipt transaction paths.
- Existing tenant context, organization predicates, RLS, and member-account validations.
- Existing MarzPay payment request, callback/webhook, settlement verification, and idempotency mechanisms.
- Existing savings interest engine and employee-loan module (separate from member lending).
- Existing records and schedules; no automatic historical recalculation or implicit acceptance of legacy guarantors.

## Migration and implementation gates

1. Before the first schema migration, compare the deployed catalog against migration history for `products`, `loans`, `loan_schedules`, `loan_guarantors`, payment intents, accounts, and tenant policies. This audit did not have live DB access, so do not treat repository migrations as proof of deployed state.
2. Design the loan receivable and income account mapping using the existing organization account model. Disbursement and repayment changes depend on this accounting decision.
3. Add new tables/columns and indexes additively. Include `organization_id`, RLS, tenant-scoped foreign-key integrity, safe defaults, and preserve historical rows.
4. Implement fee assessments/configuration before collection flows, but only post fee income after confirmed collection and through the accounting engine.
5. Introduce guarantor consent before counting a new commitment as eligible coverage; legacy guarantors remain historical/unaccepted until explicitly verified.
6. Add guarantee reservation checks to the shared server-side withdrawal path, not only the loan application page.
7. Keep phases independently deployable. Do not enable new fee deductions or reservation enforcement until their accounting and migration prerequisites are deployed.

## First implementation phase recommendation

Start by confirming deployed schema and deciding organization loan-account mappings. Then implement loan fee configuration/assessments with explicit fee statuses and no premature “paid” state. Reuse the current MarzPay confirmed-payment lifecycle. Keep fee accounting disabled until the organization has configured an income account. In parallel, add consent/audit structures that do not retroactively accept existing guarantors.

## Inspection notes

- Main service: `src/lib/loan-service.js`; eligibility/guarantor checks: `src/lib/rule-engine.js`.
- Member API: `src/app/api/loans/*`; member UI: `src/app/app/(tenant)/loans/*`.
- Core schema: `migrations/300_ledger_and_loans.mjs`, `migrations/400_sacco_engine.mjs`, tenantization: `migrations/956_organization_multitenancy.sql`.
- Ledger posting: `src/lib/transaction-service.js`; account sign mapping: `src/lib/account-ledger.js`.
- Payment engine: `src/lib/payments/*`; employee loans: `src/app/api/finance/loans/*` and `migrations/949_internal_banking_system.sql`.
- Inspected test inventory: `test/account-ledger.test.js`, `test/marzpay-disbursement-ledger.test.js`, `test/marzpay-amount-settlement.test.js`, `test/transaction-fees.test.js`, and `test/member-field-validation.test.js`.
- No code implementation or test execution was performed as part of this audit.
