# Xhenvolt Platform Control Panel

Updated: 2026-11-22

## Implemented

- Isolated `/app/platform` console and `/app/platform/login` bootstrap/login flow with a dedicated HttpOnly, SameSite strict cookie, scrypt password hashes, hashed random session tokens, eight-hour sessions, login throttling and same-origin checks.
- Separate `xhaira_platform_runtime` database role and server-only query pool. Institution APIs remain tenant scoped. Platform APIs use the separate role after platform-session validation.
- Dashboard metrics based on institution, member, account, ledger, settled payment fee and platform operation records. Amounts remain grouped by currency; transaction volume is identified separately from revenue.
- Institution directory and detail pages, account balances, activity, and reasoned suspend/reactivate actions. Suspending revokes institution sessions while retaining records.
- Transaction monitoring with institution/date/type/method/status filters, currency-separated totals and CSV export.
- Platform operation recording with idempotency, purpose, category, documentation link and accounting-treatment fields. Sensitive requests require a different super admin to approve or reject them, with audit entries.
- Platform administrator management with separate roles, session revocation on disable, and a serialized last-active-super-admin guard.
- Append-only platform audit records for authentication and administrative actions.

## Migration and first setup

Apply `migrations/977_xhenvolt_platform_control.sql` after the current tenant and finance migrations. Set `XHAIRA_PLATFORM_BOOTSTRAP_SECRET` on the server, visit `/app/platform/login`, create the first super admin, then remove or rotate the bootstrap secret. The migration must be applied before starting the platform APIs.

The 977 preflight checks only required tenant/finance objects. Payment-intent fee analytics and loan metrics are optional; the migration grants access to those tables only when they exist. If a core prerequisite is missing, the preflight now reports its exact object name.

## Accounting boundary

Scenario A institution deposits are posted to the selected institution account after dual approval, with a matching transaction and ledger row. The existing Xhaira schema has no chart-of-accounts destinations for a balanced income/liability/equity classification, so this cashbook posting is not a complete double-entry financial statement posting. The classification value is retained as metadata; it must not be treated as a verified accounting journal.

Other platform operations are stored in the distinct `platform_operations` table and do not change institution balances. Platform revenue from payment fees is displayed from settled payment-intent fee records. Subscription billing reconciliation, external platform settlement/withdrawals, and complete operational advances/reimbursements against platform bank accounts are not connected to a platform bank ledger yet.

## Validation

- `npm.cmd test`: 32 passed, 0 failed.
- The platform pages now live under `/app/platform`, with their own auth layout. Tenant pages retain their existing protected layout through the `(tenant)` route group, which does not change their public URLs.
- No database-backed migration or API check was possible from the local test process; `DATABASE_URL` was not available to tests. Apply the migration and validate it in the target database before deployment.
