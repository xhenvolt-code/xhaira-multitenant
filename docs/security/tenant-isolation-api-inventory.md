# API route inventory (source scan)

Generated 24 November 2026 from `src/app/api/**/route.js` and `route.ts`. Auth marker is a source hint, not a security verdict.

| Route file | Methods | Auth marker |
|---|---|---|
| `/api/accounts/[id]` | DELETE, GET, PATCH, PUT | auth/permission marker |
| `/api/accounts` | GET, POST | auth/permission marker |
| `/api/account-type-rules/[id]` | DELETE, GET, PUT | auth/permission marker |
| `/api/account-type-rules` | GET, POST | auth/permission marker |
| `/api/account-types/[id]` | GET, PUT | auth/permission marker |
| `/api/account-types` | GET, POST | auth/permission marker |
| `/api/activity` | GET, POST | auth/permission marker |
| `/api/admin/arch-issues` | GET, PATCH | auth/permission marker |
| `/api/admin/audit-logs` | GET | auth/permission marker |
| `/api/admin/authority-inspector` | GET | auth/permission marker |
| `/api/admin/authority-levels/[id]` | DELETE, PUT | auth/permission marker |
| `/api/admin/authority-levels` | GET, POST | auth/permission marker |
| `/api/admin/data-consistency` | GET, POST | no common auth marker; inspect |
| `/api/admin/debug` | GET | auth/permission marker |
| `/api/admin/licenses/validate` | POST, PUT | no common auth marker; inspect |
| `/api/admin/permissions/[permissionId]` | DELETE, PUT | auth/permission marker |
| `/api/admin/permissions` | GET, POST | auth/permission marker |
| `/api/admin/rbac-audit` | GET | auth/permission marker |
| `/api/admin/roles/[roleId]/permissions` | GET, PATCH, POST | auth/permission marker |
| `/api/admin/roles/[roleId]` | DELETE, GET, PUT | auth/permission marker |
| `/api/admin/roles` | GET, POST | auth/permission marker |
| `/api/admin/staff/[staffId]/create-account` | POST | auth/permission marker |
| `/api/admin/staff/[staffId]/roles` | DELETE, GET, POST | auth/permission marker |
| `/api/admin/staff/create-with-account` | POST | auth/permission marker |
| `/api/admin/user-permissions/[userId]` | GET | auth/permission marker |
| `/api/admin/users/[userId]` | DELETE, GET, PUT | auth/permission marker |
| `/api/admin/users/available-roles` | GET | auth/permission marker |
| `/api/admin/users/create` | POST | auth/permission marker |
| `/api/admin/users` | GET, POST | auth/permission marker |
| `/api/allocations` | GET, POST | auth/permission marker |
| `/api/approvals/[id]` | GET, PUT | auth/permission marker |
| `/api/approvals` | GET, POST | auth/permission marker |
| `/api/assets` | DELETE, GET, POST | no common auth marker; inspect |
| `/api/auth/login` | POST | identity/route-specific marker |
| `/api/auth/logout` | POST | no common auth marker; inspect |
| `/api/auth/me/presence` | GET, POST | auth/permission marker |
| `/api/auth/me` | GET | no common auth marker; inspect |
| `/api/auth/register` | POST | no common auth marker; inspect |
| `/api/auth/sessions/invalidate` | DELETE, POST | no common auth marker; inspect |
| `/api/auth/sessions` | DELETE, GET | auth/permission marker |
| `/api/auth/setup-password` | POST | no common auth marker; inspect |
| `/api/auth/username-suggestions` | POST | no common auth marker; inspect |
| `/api/backups/restore` | GET, POST | auth/permission marker |
| `/api/backups` | DELETE, GET, POST | auth/permission marker |
| `/api/budgets/[id]` | DELETE, GET, PUT | auth/permission marker |
| `/api/budgets` | GET, POST | auth/permission marker |
| `/api/bug-reports` | GET, POST, PUT | auth/permission marker |
| `/api/capital-allocation` | GET, POST, PUT | auth/permission marker |
| `/api/clients/[id]` | DELETE, GET, PUT | auth/permission marker |
| `/api/clients` | GET, POST | auth/permission marker |
| `/api/comments` | DELETE, GET, PATCH, POST | auth/permission marker |
| `/api/communication/[conversationId]/messages` | GET, POST | auth/permission marker |
| `/api/communication/calls/[id]` | GET, PUT | auth/permission marker |
| `/api/communication/calls` | POST | auth/permission marker |
| `/api/communication/conversations` | GET, POST | auth/permission marker |
| `/api/communication/messages/[id]` | DELETE, PUT | auth/permission marker |
| `/api/communication/message-status` | PUT | auth/permission marker |
| `/api/communication/notifications` | GET, PUT | auth/permission marker |
| `/api/communication/participants` | POST | auth/permission marker |
| `/api/communication/permissions` | GET, PUT | auth/permission marker |
| `/api/communication/presence` | GET, POST | auth/permission marker |
| `/api/communication/typing` | GET, POST | auth/permission marker |
| `/api/dashboard` | GET | auth/permission marker |
| `/api/deals/[id]` | DELETE, GET, PUT | auth/permission marker |
| `/api/deals` | GET, POST | auth/permission marker |
| `/api/decision-logs/[id]` | DELETE, GET, PUT | auth/permission marker |
| `/api/decision-logs` | GET, POST | auth/permission marker |
| `/api/departments/[id]/documents` | GET, POST | auth/permission marker |
| `/api/departments/[id]/kpis` | GET, POST | auth/permission marker |
| `/api/departments/[id]/policies` | GET, POST | auth/permission marker |
| `/api/departments/[id]/processes` | GET, POST | auth/permission marker |
| `/api/departments/[id]` | DELETE, GET, PUT | auth/permission marker |
| `/api/departments` | GET, POST | auth/permission marker |
| `/api/dividends` | GET, POST | auth/permission marker |
| `/api/docs/[id]` | DELETE, GET, PUT | auth/permission marker |
| `/api/docs` | GET, POST | auth/permission marker |
| `/api/documents` | GET, POST | auth/permission marker |
| `/api/drais/audit-logs` | GET | auth/permission marker |
| `/api/drais/health` | GET | auth/permission marker |
| `/api/drais/pricing/[id]` | DELETE, PATCH | auth/permission marker |
| `/api/drais/pricing` | GET, POST | auth/permission marker |
| `/api/drais/schools/[id]/activate` | POST | auth/permission marker |
| `/api/drais/schools/[id]` | GET, PATCH | auth/permission marker |
| `/api/drais/schools/[id]/suspend` | POST | auth/permission marker |
| `/api/drais/schools` | GET | auth/permission marker |
| `/api/drais-proxy` | GET, POST | auth/permission marker |
| `/api/employee-accounts/[id]` | DELETE, GET, PATCH | auth/permission marker |
| `/api/employee-accounts` | GET, POST | auth/permission marker |
| `/api/employees` | GET, POST, PUT | auth/permission marker |
| `/api/events` | GET, POST | auth/permission marker |
| `/api/exchange-rates` | GET, POST | auth/permission marker |
| `/api/expenses/[id]` | DELETE, GET, PUT | auth/permission marker |
| `/api/expenses` | GET, POST | auth/permission marker |
| `/api/feature-requests` | GET, POST, PUT | auth/permission marker |
| `/api/finance/account-mutations` | GET, POST | auth/permission marker |
| `/api/finance/advances/[id]` | PATCH | auth/permission marker |
| `/api/finance/advances` | GET, POST | auth/permission marker |
| `/api/finance/banking/accounts` | GET, POST | auth/permission marker |
| `/api/finance/loans/[id]` | PATCH | auth/permission marker |
| `/api/finance/loans` | GET, POST | auth/permission marker |
| `/api/finance/organization-transactions/[id]` | GET | auth/permission marker |
| `/api/finance/organization-transactions/marzpay` | GET, POST | auth/permission marker |
| `/api/finance/organization-transactions` | GET, POST | auth/permission marker |
| `/api/followups/[id]` | DELETE, GET, PUT | auth/permission marker |
| `/api/followups` | GET, POST | auth/permission marker |
| `/api/follow-ups` | GET, POST | no common auth marker; inspect |
| `/api/founder/command-center` | GET | auth/permission marker |
| `/api/groups/[id]/members` | DELETE, GET, POST | auth/permission marker |
| `/api/groups/[id]` | DELETE, GET, PATCH | auth/permission marker |
| `/api/groups` | GET, POST | auth/permission marker |
| `/api/health` | GET | identity/route-specific marker |
| `/api/integrations/[id]/rotate-keys` | POST | auth/permission marker |
| `/api/integrations/[id]/secrets` | GET | auth/permission marker |
| `/api/integrations/connections/[id]` | DELETE, PATCH | auth/permission marker |
| `/api/integrations/connections` | GET, POST | auth/permission marker |
| `/api/integrations/test` | POST | auth/permission marker |
| `/api/integrations/verify-password` | POST | auth/permission marker |
| `/api/intelligence/dashboard` | GET | auth/permission marker |
| `/api/interest/apply` | POST | auth/permission marker |
| `/api/interest` | GET, POST | auth/permission marker |
| `/api/invoices/[id]/pdf` | GET | auth/permission marker |
| `/api/invoices/[id]` | GET, PUT | auth/permission marker |
| `/api/invoices` | GET | auth/permission marker |
| `/api/issue-intelligence` | GET, PATCH, POST | auth/permission marker |
| `/api/issues/[id]` | DELETE, GET, PATCH | identity/route-specific marker |
| `/api/issues/auto-log` | GET, POST | identity/route-specific marker |
| `/api/issues` | GET | identity/route-specific marker |
| `/api/items` | DELETE, GET, PATCH, POST | auth/permission marker |
| `/api/knowledge` | DELETE, GET, PATCH, POST | auth/permission marker |
| `/api/knowledge-base/[id]` | DELETE, GET, PUT | auth/permission marker |
| `/api/knowledge-base` | GET, POST | auth/permission marker |
| `/api/ledger` | GET, POST | auth/permission marker |
| `/api/liabilities` | DELETE, GET, POST | auth/permission marker |
| `/api/licenses` | GET, PATCH, POST | auth/permission marker |
| `/api/loans/[id]/approve` | POST | auth/permission marker |
| `/api/loans/[id]/disburse` | POST | auth/permission marker |
| `/api/loans/[id]/guarantors` | DELETE, GET, POST | auth/permission marker |
| `/api/loans/[id]/reject` | POST | auth/permission marker |
| `/api/loans/[id]/repay` | POST | auth/permission marker |
| `/api/loans/[id]` | GET | auth/permission marker |
| `/api/loans/eligibility` | GET | auth/permission marker |
| `/api/loans/guarantor-candidates` | GET | auth/permission marker |
| `/api/loans` | GET, POST | auth/permission marker |
| `/api/marzpay/phone-verification` | POST | no common auth marker; inspect |
| `/api/media` | DELETE, GET, POST | auth/permission marker |
| `/api/media/stats` | GET | auth/permission marker |
| `/api/media/upload` | POST | auth/permission marker |
| `/api/member-document-configs` | GET, PUT | auth/permission marker |
| `/api/member-documents/[id]/download` | GET | auth/permission marker |
| `/api/member-documents` | GET, POST | auth/permission marker |
| `/api/member-field-configs` | GET, PUT | auth/permission marker |
| `/api/members/[id]/accounts/[accountId]/ledger` | GET | auth/permission marker |
| `/api/members/[id]/accounts` | GET, POST | auth/permission marker |
| `/api/members/[id]/audit` | GET | auth/permission marker |
| `/api/members/[id]/permanent` | DELETE | auth/permission marker |
| `/api/members/[id]` | DELETE, GET, PUT | auth/permission marker |
| `/api/members/[id]/trash` | DELETE, PATCH | auth/permission marker |
| `/api/members` | GET, POST | auth/permission marker |
| `/api/members/search` | GET | auth/permission marker |
| `/api/members/trash` | GET | auth/permission marker |
| `/api/member-transfers` | GET, POST | auth/permission marker |
| `/api/metrics` | GET | auth/permission marker |
| `/api/mobile-money/transactions/[id]` | GET | auth/permission marker |
| `/api/mobile-money/transactions` | GET, POST | auth/permission marker |
| `/api/notifications` | GET, PATCH | auth/permission marker |
| `/api/notifications/stream` | GET | auth/permission marker |
| `/api/obligations` | DELETE, GET, PATCH, POST, PUT | auth/permission marker |
| `/api/offerings/[id]` | DELETE, GET, PUT | auth/permission marker |
| `/api/offerings` | GET, POST | auth/permission marker |
| `/api/operations` | DELETE, GET, PATCH, POST | auth/permission marker |
| `/api/operations-log` | GET, POST | auth/permission marker |
| `/api/org/approvals` | GET, POST, PUT | auth/permission marker |
| `/api/org/change-logs` | GET | auth/permission marker |
| `/api/org/control-tower` | GET | auth/permission marker |
| `/api/org/structure/[id]` | DELETE, GET, PUT | auth/permission marker |
| `/api/org/structure` | GET, POST | auth/permission marker |
| `/api/organization/branding` | GET, PATCH | auth/permission marker |
| `/api/payment-collections/[id]` | GET | auth/permission marker |
| `/api/payment-collections` | GET, POST | auth/permission marker |
| `/api/payments/[id]` | GET, PUT | auth/permission marker |
| `/api/payments/convert` | GET, POST | no common auth marker; inspect |
| `/api/payments` | GET, POST | auth/permission marker |
| `/api/payouts/[id]` | GET, PATCH | auth/permission marker |
| `/api/payouts` | GET, POST | auth/permission marker |
| `/api/pipeline` | DELETE, GET, PATCH, POST | auth/permission marker |
| `/api/platform/administrators` | GET, PATCH, POST | platform guard |
| `/api/platform/audit` | GET | platform guard |
| `/api/platform/auth` | DELETE, GET, POST, PUT | identity/route-specific marker |
| `/api/platform/dashboard` | GET | platform guard |
| `/api/platform/fees` | GET, POST | platform guard |
| `/api/platform/funding/[id]` | PATCH | platform guard |
| `/api/platform/funding` | GET, POST | platform guard |
| `/api/platform/institutions/[id]` | GET, PATCH | platform guard |
| `/api/platform/institutions` | GET | platform guard |
| `/api/platform/transactions` | GET | platform guard |
| `/api/presence/ping` | POST | auth/permission marker |
| `/api/presence/status` | GET | auth/permission marker |
| `/api/pricing/[id]/cycles/[cycleId]` | DELETE, PATCH | auth/permission marker |
| `/api/pricing/[id]/cycles` | GET, POST | auth/permission marker |
| `/api/pricing/[id]` | DELETE, GET, PATCH | auth/permission marker |
| `/api/pricing` | GET, POST | auth/permission marker |
| `/api/pricing/system/[system]` | GET | no common auth marker; inspect |
| `/api/products/[id]/changes` | GET, PATCH, POST | auth/permission marker |
| `/api/products/[id]/issues` | GET, PATCH, POST | auth/permission marker |
| `/api/products/[id]/modules/[moduleId]` | DELETE, GET, PATCH | auth/permission marker |
| `/api/products/[id]/modules` | GET, POST | auth/permission marker |
| `/api/products/[id]/operations` | GET, POST | auth/permission marker |
| `/api/products/[id]/plans` | GET, POST | auth/permission marker |
| `/api/products/[id]` | DELETE, GET, PUT | auth/permission marker |
| `/api/products/[id]/tech-profiles/[profileId]` | DELETE, GET, PATCH | auth/permission marker |
| `/api/products/[id]/tech-profiles` | GET, POST | auth/permission marker |
| `/api/products/[id]/tech-stack` | DELETE, GET, POST, PUT | no common auth marker; inspect |
| `/api/products` | DELETE, GET, POST | auth/permission marker |
| `/api/prospects/[id]/contacts` | GET, POST | auth/permission marker |
| `/api/prospects/[id]/convert` | POST | auth/permission marker |
| `/api/prospects/[id]` | DELETE, GET, PUT | auth/permission marker |
| `/api/prospects` | GET, POST | auth/permission marker |
| `/api/receipts/[receiptNumber]` | GET | auth/permission marker |
| `/api/receipts/verify` | GET | identity/route-specific marker |
| `/api/reports` | GET | auth/permission marker |
| `/api/resources` | DELETE, GET, PATCH, POST | no common auth marker; inspect |
| `/api/revenue-events` | GET, POST | auth/permission marker |
| `/api/roles/search` | GET | auth/permission marker |
| `/api/sacco-configurations` | GET, POST | auth/permission marker |
| `/api/sacco-products/[id]` | GET, PUT | auth/permission marker |
| `/api/sacco-products` | GET, POST | auth/permission marker |
| `/api/sacco-rules/[id]` | DELETE, PUT | auth/permission marker |
| `/api/sacco-rules` | GET, POST | auth/permission marker |
| `/api/salary-accounts` | GET, POST | no common auth marker; inspect |
| `/api/savings/accounts/[id]` | GET | auth/permission marker |
| `/api/savings` | GET, POST | auth/permission marker |
| `/api/services/[id]` | DELETE, GET, PUT | auth/permission marker |
| `/api/services` | GET, POST | auth/permission marker |
| `/api/shares/[id]` | GET, PUT | auth/permission marker |
| `/api/shares` | GET, POST | auth/permission marker |
| `/api/staff/actions` | GET, POST | auth/permission marker |
| `/api/staff` | DELETE, GET, PATCH, POST | auth/permission marker |
| `/api/subscriptions/[id]/billing` | GET | auth/permission marker |
| `/api/subscriptions/[id]/cancel` | POST | auth/permission marker |
| `/api/subscriptions/[id]/renew` | POST | auth/permission marker |
| `/api/subscriptions/[id]` | GET, PATCH | auth/permission marker |
| `/api/subscriptions` | GET, POST | auth/permission marker |
| `/api/system/state` | GET | no common auth marker; inspect |
| `/api/system-costs` | DELETE, GET, POST | auth/permission marker |
| `/api/system-events` | GET | auth/permission marker |
| `/api/system-logs` | DELETE, GET | auth/permission marker |
| `/api/systems/[id]/changes` | GET, PATCH, POST | auth/permission marker |
| `/api/systems/[id]/issues` | GET, PATCH, POST | auth/permission marker |
| `/api/systems/[id]/modules/[moduleId]` | DELETE, GET, PATCH | auth/permission marker |
| `/api/systems/[id]/modules` | GET, POST | auth/permission marker |
| `/api/systems/[id]/operations` | GET, POST | auth/permission marker |
| `/api/systems/[id]/plans` | GET, POST | auth/permission marker |
| `/api/systems/[id]` | DELETE, GET, PUT | auth/permission marker |
| `/api/systems/[id]/tech-profiles/[profileId]` | DELETE, GET, PATCH | auth/permission marker |
| `/api/systems/[id]/tech-profiles` | GET, POST | auth/permission marker |
| `/api/systems/[id]/tech-stack` | DELETE, GET, POST, PUT | no common auth marker; inspect |
| `/api/systems` | GET, POST | auth/permission marker |
| `/api/tech-stack` | DELETE, GET, POST | auth/permission marker |
| `/api/tech-stacks/[id]/credentials/[credId]` | DELETE | auth/permission marker |
| `/api/tech-stacks/[id]/credentials` | GET, POST | auth/permission marker |
| `/api/tech-stacks/[id]/items/[itemId]` | DELETE, PATCH | auth/permission marker |
| `/api/tech-stacks/[id]/items` | GET, POST | auth/permission marker |
| `/api/tech-stacks/[id]` | DELETE, GET, PATCH | auth/permission marker |
| `/api/tech-stacks` | GET, POST | auth/permission marker |
| `/api/transactions/[id]` | DELETE, GET | auth/permission marker |
| `/api/transactions` | GET, POST | auth/permission marker |
| `/api/transfers/[id]` | GET | auth/permission marker |
| `/api/transfers` | GET, POST | auth/permission marker |
| `/api/users/presence` | GET | auth/permission marker |
| `/api/users/search` | GET | auth/permission marker |
| `/api/webhooks/marzpay` | POST | identity/route-specific marker |
