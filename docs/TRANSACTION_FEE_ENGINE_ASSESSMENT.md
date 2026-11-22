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
- `migrations/980_transaction_party_and_fee_summary.sql` promotes transaction reason, depositor, receiver, principal and aggregate-charge fields to the transaction model. Existing metadata remains as a backward-compatible source.
- Organization receipts show one combined “Transaction charges” line with the amount withdrawn/credited; they do not display separate Xhenvolt, MarzPay, or SACCO fee components. The Xhenvolt component remains available in the internal calculation snapshot for platform reporting.
- Savings and MarzPay forms collect a transaction reason and relevant party names. Deposit recipients and withdrawal depositors are derived from the member account; the entered depositor/receiver is stored alongside them.

## Posting integration intentionally remains pending

The current balanced postings cannot yet safely express the requested fee splits: a deposit posts one equal settlement-wallet debit/member credit, and a withdrawal posts one equal member debit/wallet credit. The calculator still is not wired into payment initiation, settlement amounts, or member fee previews, and there is no fee schedule control panel. The transaction charge summary field is ready for posting once the fee calculation is integrated; currently only MarzPay-confirmed charges are written to receipts.

The remaining accounting decision is the destination and settlement mechanism for the combined provider-fee liability, including Xhenvolt's share, plus the organization service-fee income account. Once confirmed, integrate versioned configuration and snapshots into the amount preparation and balanced ledger allocation while retaining the existing callback, webhook, idempotency and reconciliation behavior.
