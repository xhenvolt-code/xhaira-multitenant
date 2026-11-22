# Major Financial Platform Enhancement — Stage 1 Assessment

Date: 2026-11-22

## Scope

Stage 1 is direct deposits and withdrawals on organization-owned accounts. The requested flow must reuse the financial engine, preserve tenant scoping, classify receipts correctly, produce balanced postings, and keep existing workflows intact.

## What exists

- `accounts` and `ledger` track organization-owned cash, bank, mobile money, and related asset accounts. Account balances are derived from ledger rows through `v_account_balances`.
- `ledger_entries` and `transactions` provide a double-entry mechanism. `createTransaction` validates that debits equal credits, verifies account ownership against `public.current_organization_id()`, creates both sides, and mirrors entries associated with `accounts` into `ledger`.
- `/api/accounts` already returns organization-scoped accounts and computed balances.
- `/api/ledger` already lists organization-scoped account activity.
- Finance routes already include accounts, ledger, expenses, transfers, budgets, loans, and banking.

## Accounting conflict that blocks safe implementation

The current schema does not provide a chart of accounts for revenue, liabilities, and equity. The `accounts` table is used for real asset accounts (bank, cash, mobile money, etc.). The legacy account type constraint likewise describes asset/payment accounts. There is no existing, tenant-scoped accounting destination for classifying a grant as restricted funding, borrowed funds as a liability, or capital contributions as equity.

The ledger's `category` is free text and does not provide a balanced accounting destination. Posting only a positive cash ledger row would incorrectly flow into `v_financial_summary.total_income`, which currently classifies every positive ledger amount as income. Choosing an arbitrary second asset account would misstate the organization's position. Neither approach meets the requested accounting treatment.

There is also a compatibility issue to resolve before reusing `createTransaction` for organization-account transfers: it mirrors account entries into `ledger` using `transaction_type` as `source_type`, while the `ledger.source_type` constraint has no `transfer` value. Existing transfer code writes `transfer_in` and `transfer_out` directly. This existing behavior should be addressed only with a migration and regression coverage that preserves current transfer records and APIs.

## Safe prerequisite

Before adding direct organization deposits and withdrawals, define and migrate the tenant-scoped accounting destinations and posting rules for at least:

- Asset accounts (the existing bank/cash accounts).
- Income and expense accounts.
- Liability and equity accounts.
- Journal transactions with balanced, immutable lines and references to the operational cash/bank ledger.
- Reporting rules that distinguish cash movement, transaction volume, income, liabilities, and equity.

Then route organization receipts and disbursements through the same atomic posting service, with an explicit classification account, transaction metadata, audit entry, and idempotency key. Transfers between asset accounts can use transfer-in/transfer-out classification and must remain neutral to income.

## Initial inspection (before implementation)

- Inspected the transaction service, account and ledger APIs, finance navigation, account and ledger schemas, and the existing balance/reporting views.
- Added this assessment to document the discovered accounting conflict before changing financial posting behavior.
- Preserved the pre-existing worktree changes in `src/app/api/transfers/route.js` and `migrations/975_ledger_transfer_source_types.sql`.

## Initial validation

- `npm.cmd test`: passed, 26 tests, 0 failures.
- The suite includes financial account sign mapping and MarzPay settlement/idempotency coverage. It does not exercise direct organization transactions, chart-of-accounts classification, or tenant isolation for those new flows.
- No database-backed validation was run; the test process reports `DATABASE_URL` is not set.

## Stage 1 status

This was the status at the initial inspection, before the follow-up implementation below.

## Follow-up implementation status

An operational organization cashbook flow was added using the existing `ledger` and `transactions` tables. It writes deposits and withdrawals atomically to the selected organization account and preserves a classification label in ledger category and transaction metadata. It does not provide true revenue/liability/equity account posting; the accounting prerequisite above remains open for correct financial statement classification.

The implementation adds a finance route, tenant-authorized API, reason/counterparty and actor metadata, audit logging, receipt lines, and idempotency protection. Staff-recorded member deposits/withdrawals also carry reason, payer/recipient, and authenticated actor details through transaction history and receipts.

Updated validation: `npm.cmd test` passed 32 tests. A production build compiled successfully once; a second build is running after the final UI adjustments. Database-backed checks remain unavailable because `DATABASE_URL` is unset for the test process. Migration `976_organization_transaction_idempotency.sql` must be applied before deployment.

Stage 1 is partially implemented. Stages 2–6 remain unstarted until the financial classification prerequisite is addressed.
