# Transaction fee enhancement: existing flow and accounting boundary

## Existing MarzPay flow inspected

- Deposits reserve `payment_intents.amount_minor` as the requested collection amount and send that value to MarzPay. The existing organization setting `payments.marzpay.collection_fee_rule` supplies a payer-borne percentage (migration 962 currently seeds 300 basis points). The reconciliation path validates the provider amount and, on successful collection, posts the same `ledgerAmountMinor` as a debit from the organization's MarzPay settlement account and a credit to the member account.
- Withdrawals send `amount_minor` to MarzPay. After provider completion, the existing idempotent ledger poster debits the member by that amount and credits the organization settlement account by that amount. The disbursement service records provider fee evidence and reconciliation variance separately.
- `payment_intents` retains provider amount, provider fee and ledger amount, but no fee schedule version or split revenue allocation.
- SACCO configuration is tenant-scoped and managed through `/api/sacco-configurations`. Its MarzPay fee value is currently a mutable JSON setting, rather than a historical versioned schedule.
- The inspected code has no platform-level fee schedule, platform revenue destination, or Xhenvolt fee allocation ledger classification. `accounts` are organization-scoped.

## Additive groundwork in this change

- `src/lib/payments/transaction-fees.js` calculates fee previews using integer minor units and basis points, with half-up rounding, optional min/max limits, disabled components, and the calculation inputs needed to retain configuration versions.
- `migrations/965_transaction_fee_engine.sql` adds immutable effective-dated configuration records for organization and platform scopes, audit identity/reason, and a JSON fee snapshot field on payment intents.
- `test/transaction-fees.test.js` covers the requested deposit/withdrawal examples, organization fee ordering, disabled components, bounds, rounding, and invalid inputs.

## Posting integration intentionally remains pending

The current balanced postings cannot safely express the requested fee splits: a deposit currently posts one equal wallet debit/member credit, and a withdrawal posts one equal member debit/wallet credit. Applying the preview output to those postings would either change a member balance, misstate the organization settlement wallet, or leave Xhenvolt/SACCO gateway costs unreconciled. No designated Xhenvolt revenue account or validated inter-organization settlement mechanism was found. Therefore the new calculator is not wired into payment initiation, settlement posting, or member previews, and the migration does not claim to enable live centralized fee changes.

Before that integration, the accounting owner must confirm where each component is held/settled, how Xhenvolt revenue crosses tenant boundaries, and which postings MarzPay's actual contract expects for the increased collection request and withdrawal wallet deduction. The smallest safe implementation then needs separate fee allocation entries (or an approved receivable/settlement flow), immutable fee snapshots on intents/transactions, and preview quote validity. The existing callback, webhook, settlement verification, idempotency and reconciliation paths should remain unchanged unless that design proves a specific incompatibility.
