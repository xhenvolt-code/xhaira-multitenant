# Xhaira tenant isolation audit — Stage 1

**Reviewed:** 24 November 2026  
**Scope:** source and migration review; no source, schema, MarzPay, or financial logic changed.

## A. Executive summary

The members API query is scoped to the organization resolved from the session, but the client cache is not tenant-scoped. The user-reported behavior is explained by a confirmed UI state-isolation flaw: member context stores records by member ID only, and member detail can display a cached record without revalidating it against the current session. If the authenticated organization changes while the App Router preserves that client state, the old tenant’s member data can remain visible until a full refresh. This is a cross-tenant data exposure in the browser, even though the reviewed API query itself is organization-scoped.

The report distinguishes the confirmed client-side member leak from server-side SQL exposure. I did not confirm a direct cross-tenant member, account, ledger, loan, or transaction response from the focused API query review. Two areas still need validation against the deployed database: (1) unauthenticated data-consistency APIs aggregate through legacy views created before RLS; whether counts cross tenants depends on deployed view-owner privileges; and (2) several legacy APIs omit authentication and rely on empty tenant context plus RLS to deny access.

The public receipt verification API intentionally uses the platform `BYPASSRLS` pool. A valid HMAC receipt stamp is a bearer capability and the response includes organization name, transaction type, amount, currency, and timestamp. This appears to be the designed receipt-verification flow, rather than an arbitrary tenant selector, but it means anyone holding a valid QR/stamp can read that receipt metadata.

This is a source-level assessment, not a production proof. No production database was queried, no two-tenant runtime probes were run, and the actual role attributes, view owners, applied migration set, and deployed policies remain unverified. See the coverage note in section C.

## B. Existing tenant architecture

`Authenticated user → session cookie → server-side session lookup → organization from session row → RBAC permission check → tenant context (AsyncLocalStorage) → xhaira_runtime connection with app.organization_id → explicit SQL organization predicates plus RLS → response`

- Login validates credentials through `findUserByEmail()` → `public.lookup_login_user(email)` and creates a server-side session with that user’s organization. The browser cookie contains the session ID, not a JWT. Registration creates an organization owner through `public.create_organization_owner(...)`.
- `verifyAuth()` reads the HTTP-only `xhaira_session` cookie, calls `getSession()`, and enters the organization ID returned by `lookup_session_details()`. The SQL function joins `sessions` to `users` on both IDs and organization IDs, and rejects expired or revoked sessions. There is one `organization_id` on the user/session model; no multi-organization membership or organization-switch flow was found in the reviewed auth path.
- `requirePermission()` calls `verifyAuth()`, rejects unauthenticated, pending, and suspended accounts, then checks the user’s role permissions. Organization superadmins bypass module permission checks but still carry the session organization.
- `getPool()` is a wrapper over `pg.Pool`. On every checked-out connection it executes `SET ROLE xhaira_runtime` and sets `app.organization_id` from AsyncLocalStorage; on release it clears that setting and resets the role. `956_organization_multitenancy.sql` creates `xhaira_runtime` as `NOBYPASSRLS` and forces RLS on the tenant tables then present. Later tenant tables mostly add their own RLS policies.
- `public.current_organization_id()` returns the UUID from the connection setting or NULL for an empty setting. Its correctness depends on server code setting the context correctly and on the caller not using an alternate pool.
- Platform endpoints use a separate `xhaira_platform_runtime` role with `BYPASSRLS`; the reviewed platform routes call `requirePlatformAdmin()`. This is a deliberate elevated boundary. `getPlatformPool()` is also used by public receipt verification, so that exception must remain narrowly constrained.
- No Redis, `unstable_cache`, `force-cache`, or shared response-cache mechanism was found by source search. Many private routes explicitly use `Cache-Control: private, no-store`; receipt verification uses `no-store`.
- No relevant Next.js middleware enforcing API auth was found. API security is implemented in each route/helper, not globally.

### Identity substitution / loss points

1. SQL RLS trusts `app.organization_id`; it does not itself verify that this UUID belongs to the current user. The application currently supplies it from the validated session in the reviewed tenant routes. A future route that accepts client input and calls `runWithOrganizationContext()` would defeat this boundary unless it first proves membership.
2. `getPlatformPool()` deliberately bypasses RLS. Its use in receipt verification is a bearer-stamp public read; use elsewhere must be gated by independent platform auth.
3. `956` is a one-time RLS pass over tables existing at migration time. New tenant tables need explicit tenant constraints/RLS; the generic default grants alone do not install policies.
4. `enterOrganizationContext()` validates UUID syntax, not user authorization. Its safety depends on call-site data provenance.

## C. Complete API inventory and coverage

The checked-in inventory is [tenant-isolation-api-inventory.md](tenant-isolation-api-inventory.md). It enumerates all **271** `src/app/api/**/route.js` files and the exported HTTP methods found in each. No separate `app/api` tree or TypeScript API route was found. There are no `use server` action modules under `src/app` in the checked search.

The inventory is complete as a route-file/method list. The source review prioritized tenant-sensitive auth, database context, RLS, dashboard, financial, member, document, receipt, platform, and legacy unauthenticated paths. It is **not an assertion that every SQL statement in all 534 exported handlers was manually traced**. Remaining route bodies and indirect library calls need a dedicated second pass before treating the entire application as cleared. The inventory labels missing common auth markers for manual review; absence of a marker alone is not a confirmed vulnerability.

## D. Confirmed vulnerabilities

### Confirmed — stale member client cache can display a previous tenant’s records

- **Functional area / files:** Members; `src/app/app/(tenant)/members/members-data-context.js:8-36`, `src/app/app/(tenant)/members/page.js:22-75, 108-111`, `src/app/app/(tenant)/members/[id]/page.js:58-71, 136-158`, and `src/components/providers/PermissionProvider.js:24-55`.
- **HTTP method / database tables:** the normal list request is `GET /api/members` and reads `members`, `users`, `member_accounts`, `member_documents`, and tenant-scoped balance views. The detail page can skip `GET /api/members/[id]` entirely if the context already has that member.
- **Authentication and authorization:** the server API uses `requirePermission('members.view')`; `src/app/api/members/route.js:12-16` derives the org from `perm.auth.organizationId` and wraps the query in that context. The list SQL also has `m.organization_id = $1`. The member endpoint is not the source of the stale record in this scenario.
- **Tenant context / client input:** there is no client-supplied tenant ID. However, `MembersDataProvider` stores records in `membersById` under only `member.id`; it has no organization key or invalidation when auth identity changes. The app-wide `PermissionProvider` loads `/api/auth/me` once on mount and does not observe session/organization changes. The members list fetch effect depends on view/search/status, not authenticated organization identity.
- **Exact mechanism:** when a tenant identity changes in a client navigation where the App Router retains/restores these client components, cached member state remains from the previous organization. In the member detail page, `getMember(id)` initializes visible member state and `fetchData()` treats a cached entry as authoritative, skipping the tenant-authorized detail API request. This matches the reported “until refresh” behavior. A full document refresh destroys that in-memory state and causes a fresh session-scoped list fetch.
- **Data exposed:** member profile fields retained in client state (name, contact details, membership number, status, and cached balance/account summary). Severity is **HIGH** under the brief’s personal-information category.
- **Confidence:** the tenant-unkeyed cache and cache-hit API bypass are confirmed in source. The observed behavior depends on the app retaining the client tree across an identity change; the user reports that behavior. I did not reproduce it in a running browser.
- **Recommended minimal correction:** bind client member state to the authenticated organization/session identity and clear it before rendering when that identity changes. Do not serve a cached member detail as authorization; revalidate it through the organization-scoped API before displaying sensitive fields. Ensure auth context refreshes/reinitializes on login/logout/session changes.

This finding explains a real cross-tenant display without asserting that the database returned another organization’s rows. The static evidence also establishes server-derived tenant context and forced RLS for core tables, but cannot prove deployed roles, grants, policies, migration state, or view ownership.

## E. Potential vulnerabilities and unsafe paths

### P1 — Legacy unauthenticated APIs depend entirely on RLS

- **Files:** `src/app/api/follow-ups/route.js` (GET/POST, lines 10–84); `src/app/api/salary-accounts/route.js` (GET/POST, lines 10–66); `src/app/api/payments/convert/route.js` (GET/POST, lines 10–111; POST is actually a payment insert despite the path name); `src/app/api/systems/[id]/tech-stack/route.js` (GET/POST/PUT/DELETE, lines 10–147); `src/app/api/products/[id]/tech-stack/route.js` (GET/POST/PUT/DELETE, lines 10–147); `src/app/api/admin/licenses/validate/route.js` (POST/PUT, lines 10–160); `src/app/api/admin/data-consistency/route.js` (GET/POST, lines 10–90); and `src/app/api/auth/sessions/invalidate/route.js` (POST/DELETE, lines 10–62).
- **Authentication:** no session/permission helper in these handlers (the currency GET is a public calculator and is not tenant data).
- **Tenant input:** some take record IDs from URL/body/query; none of those values establishes a tenant context.
- **Current protection:** tenant-aware `getPool()` sets an empty org setting when no authenticated request context exists; correctly applied RLS should therefore return no rows and reject tenant writes. This is fail-closed only while those tables have RLS, the pool wrapper is used, and runtime role remains `NOBYPASSRLS`.
- **Mechanism / impact:** a missing policy, alternate connection path, or elevated owner/view/function can turn these endpoints into anonymous read/write paths. For the financial payment insert this is an attempted ledger-adjacent write with client-supplied account/deal references. No source proof that a foreign record currently passes RLS was found; classify as **potential**, not confirmed. RLS does not replace endpoint authentication or business authorization.
- **Additional behavior:** `/api/auth/sessions/invalidate` is unauthenticated and accepts a caller-supplied user/session ID, but its function/query currently uses the tenant runtime pool with no tenant context; RLS should block the operation. `/api/issues/[id]` DELETE is also unauthenticated, though the current handler references an unimported `pool` and therefore appears to fail before querying. `/api/issues/auto-log` deliberately accepts anonymous error reports and does not return tenant records. These are auth/availability or integrity issues, not confirmed cross-tenant reads.
- **Recommended minimal correction:** require the existing permission helper for tenant operations, derive organization only from its `auth.organizationId`, and retain SQL tenant predicates. Keep only genuinely public read-only utilities public.

### P2 — Unauthenticated global counts through legacy diagnostic views (conditional)

- **Route:** `GET /api/admin/data-consistency`, `src/app/api/admin/data-consistency/route.js:10-55`; no authentication or authorization is called.
- **Tables/views:** `v_orphaned_users`, `v_orphaned_staff`, `v_invalid_roles`, `v_inconsistent_currencies`, and `operations_log`.
- **Evidence:** `migrations/946_data_consistency_logging.sql:23-77` creates the four views without `security_invoker`; they select tenant-owned user, staff, role, payment, account, and deal metadata. The route returns their counts. The migration predates `956` RLS installation.
- **Status:** **potential cross-tenant aggregation leak, conditional on the deployed view owner’s privileges and PostgreSQL view security behavior.** The route and views are unambiguously unauthenticated/global in design; whether `xhaira_runtime` can see all rows depends on deployed view owner (especially superuser/BYPASSRLS status), which cannot be established from source. No customer rows are returned by this route, only counts.
- **Severity:** **MEDIUM** if global view counts are observable; otherwise an unauthenticated diagnostic endpoint that currently returns zero/empty or errors. `POST /api/admin/data-consistency` (lines 62-90) is also unauthenticated and invokes cleanup/logging plus broad updates; RLS/invoker behavior should be verified before considering its write impact.
- **Recommended minimal correction:** require the existing admin permission; scope every diagnostic query to authenticated organization, or move this into a separately authorized platform-only operation. Make views security-invoker or replace them with explicitly organization-scoped queries. Do not expose orphan identities or global metrics to ordinary tenant users.

### P3 — Public receipt verification reveals signed receipt details (designed disclosure)

- **Route:** `GET /api/receipts/verify`, `src/app/api/receipts/verify/route.js:8-68`.
- **Auth/context:** no user session; uses `queryPlatform()` (`BYPASSRLS`) after validating a 256-bit HMAC stamp in `src/lib/receipts/receipt-stamp.js`.
- **Data returned:** organization name, transaction type, issue timestamp, amount, charges, and currency, selected globally by receipt number.
- **Status:** not an arbitrary IDOR: the HMAC stamp is required and acts as a bearer capability; `no-store` is set. A person who obtains a genuine QR/stamp can see the receipt’s financial metadata. Treat as **intentional public disclosure with residual privacy risk**, not a confirmed cross-tenant isolation bypass. Verify product policy accepts sharing those fields and keep the secret strong/private.

### P4 — Public registration has no first-user-only guard in the handler

- **Route:** `POST /api/auth/register`, `src/app/api/auth/register/route.js`; imports `getUserCount` but does not call it. The comments say later registration should be closed, while each accepted request invokes the security-definer organization-owner function.
- **Status:** confirmed mismatch between route comments and implementation, but **not a cross-tenant data leak** by itself. It may allow unauthorized self-service tenant creation, depending on intended onboarding policy. `lookup_login_user(email)` is global and `LIMIT 1`; deployment schema uniqueness and concurrent-registration behavior should be checked before drawing further conclusions.

## F. Root causes

1. Security responsibility is split between per-route permission checks, explicit SQL predicates, AsyncLocalStorage context, pool role switching, and database policies. A route can omit auth and silently rely on RLS.
2. RLS only protects tables where policies are present and on queries executed under the intended runtime role. Legacy views and elevated platform pool calls create exceptions.
3. Migration 956’s table sweep is not a durable default for future schemas. New tenant-owned tables need explicit ownership, composite tenant relationships, RLS, and grants in the same migration.
4. Some legacy API paths appear to predate multi-tenancy and lack endpoint-level authorization even though current RLS may stop cross-tenant data reads.

## G. Risk ranking

| Rank | Finding | Severity | Confidence |
|---|---|---:|---|
| 1 | Member records remain cached across client-side tenant identity changes | High | Confirmed source flaw; user reports observed behavior |
| 2 | Unauthenticated consistency diagnostics over pre-RLS views | Medium if view owner bypasses RLS | Conditional; deployed database check required |
| 3 | Unauthenticated legacy tenant routes relying on RLS only | High potential, not demonstrated | Missing auth confirmed; foreign API access not proven |
| 4 | Public bearer-stamp receipt metadata | Medium privacy exposure | Confirmed intended behavior |
| 5 | Registration does not enforce documented first-user-only policy | High onboarding risk; outside direct tenant leak | Confirmed source mismatch |

## H. Recommended remediation

1. Immediately isolate/invalidate frontend member cache by authenticated tenant identity and remove the detail-page cache bypass for sensitive member data.
2. Verify deployed database state with read-only checks: applied migrations; `rolbypassrls`/superuser flags for runtime and view owners; `relrowsecurity`/`relforcerowsecurity`; policies; view definitions/owners; and grants on tables created after 956. Use synthetic tenants only.
3. Add existing `requirePermission()` checks to tenant read/write handlers that lack them; derive org from `auth.organizationId`, retaining explicit org predicates.
4. Constrain diagnostic routes to authorized tenant scope or move global scans to an explicitly platform-admin-only endpoint. Make diagnostic views security-invoker where supported.
5. Add a migration review gate for each new tenant table: organization_id, tenant-aware foreign keys, forced RLS policy, runtime grants, and safe views/functions.
6. Decide and enforce the documented registration policy; preserve the receipt HMAC flow only with its current limited fields if public verification is intended.

## I. Regression test plan

Use synthetic Org A/Org B records and two ordinary users plus one authorized platform administrator. Run API integration tests under the actual `xhaira_runtime` role and separately verify platform routes under their intended guard. Assert same-tenant reads/writes succeed; foreign record IDs return a consistent 404 or non-disclosing denial; client-supplied org IDs are ignored/rejected; list, search, pagination, CSV/PDF/export, dashboard aggregates, joins, documents, receipts, and pending payment status never cross scopes; diagnostic counts are tenant-local; cached results are never shared; unauth legacy endpoints reject; and platform-wide reads work only for platform sessions. Include pool-reuse tests alternating Org A, Org B, and no-context requests on the same pool, and tests that a failed reset destroys/releases the connection safely. Use only synthetic data.

No tests or production probes were run during this investigation.

## J. Implementation roadmap

1. Clear and tenant-key the member cache; ensure detail/profile requests are authorized by the server before showing personal data.
2. Verify deployed RLS/role/view state and restrict diagnostic APIs.
3. Add endpoint authorization to unauthenticated tenant routes, preserving existing auth/RBAC and financial services.
4. Review remaining API routes for per-object authorization, tenant joins, writes, and indirect helpers; add two-tenant regression tests.
5. Resolve registration policy and receipt disclosure policy with intended product behavior.

## K. Files likely to change in remediation

- `src/app/app/(tenant)/members/members-data-context.js`, `src/app/app/(tenant)/members/page.js`, `src/app/app/(tenant)/members/[id]/page.js`, and `src/components/providers/PermissionProvider.js` (tenant-key/invalidate cached state; revalidate detail records).
- `src/app/api/admin/data-consistency/route.js`; `migrations/946_data_consistency_logging.sql` (view security mode and any tenant-scope change).
- Legacy routes listed under P1, especially `src/app/api/follow-ups/route.js`, `src/app/api/salary-accounts/route.js`, `src/app/api/payments/convert/route.js`, and the system/product tech-stack endpoints.
- `src/app/api/auth/register/route.js` (registration-policy enforcement only after policy is confirmed).
- A new automated tenant-isolation test suite and, if deployed catalog checks identify gaps, narrowly scoped RLS/view migrations. No specific schema migration can be responsibly prescribed until deployed policies and owners are queried.

## Stage 2 implementation update

After the user reported that the members route displays another organization’s members until refresh, the client-side cache finding above was addressed in source:

- Member cache entries are keyed by authenticated organization and user.
- Member detail always fetches the record from the session-scoped API before displaying it; cache hits no longer bypass server authorization.
- The member list clears and reloads when its known user/organization identity changes, and suppresses data tagged to a different identity while loading.
- Successful login, registration, and forced-password setup enter the app with a full document navigation so in-memory state from a previous session is discarded.

These are targeted UI-state corrections. No database, API authorization, schema, or MarzPay changes were made. No tests or build were run. The unauthenticated legacy API and deployed database/view-owner checks in sections E and H remain outstanding.

