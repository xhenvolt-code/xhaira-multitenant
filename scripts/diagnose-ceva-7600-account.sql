-- Read-only discovery query for the organization account reportedly holding
-- approximately UGX 7,600. This intentionally does not delete or update rows.
-- Run it first and review the returned organization/account IDs.

WITH target_organizations AS (
  SELECT id, name, slug
    FROM public.organizations
   WHERE lower(trim(name)) = lower('Ceva Community Development Organization')
),
account_balances AS (
  SELECT a.id AS account_id,
         a.organization_id,
         COALESCE(SUM(l.amount), 0)::numeric(18,2) AS balance,
         COUNT(l.id)::bigint AS company_ledger_rows,
         MAX(l.entry_date) AS last_ledger_date
    FROM public.accounts a
    LEFT JOIN public.ledger l
      ON l.account_id = a.id
     AND l.organization_id = a.organization_id
   GROUP BY a.id, a.organization_id
),
transaction_links AS (
  SELECT le.account_id,
         le.organization_id,
         COUNT(*)::bigint AS linked_ledger_entries,
         COUNT(DISTINCT le.transaction_id)::bigint AS linked_transactions,
         array_agg(DISTINCT le.transaction_id ORDER BY le.transaction_id)
           FILTER (WHERE le.transaction_id IS NOT NULL) AS transaction_ids
    FROM public.ledger_entries le
   WHERE le.account_id IS NOT NULL
   GROUP BY le.account_id, le.organization_id
)
SELECT o.id AS organization_id,
       o.name AS organization_name,
       o.slug AS organization_slug,
       a.id AS account_id,
       a.name AS account_name,
       a.type AS account_type,
       a.currency,
       a.account_number,
       a.is_active,
       b.balance AS organization_account_balance,
       b.company_ledger_rows,
       b.last_ledger_date,
       COALESCE(t.linked_ledger_entries, 0) AS linked_ledger_entries,
       COALESCE(t.linked_transactions, 0) AS linked_transactions,
       t.transaction_ids,
       abs(b.balance - 7600.00) AS distance_from_UGX_7600
  FROM target_organizations o
  JOIN public.accounts a
    ON a.organization_id = o.id
  JOIN account_balances b
    ON b.account_id = a.id
   AND b.organization_id = a.organization_id
  LEFT JOIN transaction_links t
    ON t.account_id = a.id
   AND t.organization_id = a.organization_id
 ORDER BY abs(b.balance - 7600.00), a.name, a.id;

