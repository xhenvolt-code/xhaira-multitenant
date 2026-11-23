-- Purge the specifically reviewed CEVA organization cash account and its four
-- linked double-entry transactions. This is intentionally one-time and
-- destructive. Run only after migration 978_transaction_delete_support.sql.
--
-- The guards below ensure this cannot silently target a replacement account,
-- changed balance, or a different set of transactions. Any transaction linked
-- by a foreign key outside ledger_entries causes the migration to abort rather
-- than cascading into loans or other business records.

BEGIN;

SELECT set_config('app.organization_id', 'dee36382-d2be-4a93-bfaf-c1b388621623', true);
SELECT set_config('app.allow_transaction_delete', 'on', true);

DO $$
DECLARE
  expected_organization_id CONSTANT uuid := 'dee36382-d2be-4a93-bfaf-c1b388621623';
  expected_account_id CONSTANT uuid := 'f10f753f-550d-4b3a-befe-eca21648088f';
  expected_transaction_ids CONSTANT uuid[] := ARRAY[
    '8a755d31-1a0e-4e33-8761-cc30cb8ecb8f'::uuid,
    '8ab01147-11c2-4364-8988-8a40e30c4f86'::uuid,
    'c24fee7c-ecf4-4617-ac8e-c005fa2e5f8c'::uuid,
    'db24fdce-ea64-4192-9807-387e5e925a50'::uuid
  ];
  actual_transaction_ids uuid[];
  current_balance numeric(18,2);
  company_ledger_rows bigint;
  deleted_ledger_rows bigint;
  deleted_transactions bigint;
  deleted_accounts bigint;
  fk RECORD;
  referenced_rows bigint;
BEGIN
  -- Verify the organization identity supplied by the discovery query.
  IF NOT EXISTS (
    SELECT 1
      FROM public.organizations
     WHERE id = expected_organization_id
       AND lower(trim(name)) = lower('CEVA COMMUNITY DEVELOPMENT ORGANIZATION')
       AND slug = 'CEVA-CDO'
  ) THEN
    RAISE EXCEPTION 'CEVA organization identity changed; purge cancelled';
  END IF;

  -- Verify the exact account and the UGX 7,000 balance shown in the query.
  SELECT COALESCE(SUM(l.amount), 0)::numeric(18,2), COUNT(l.id)
    INTO current_balance, company_ledger_rows
    FROM public.accounts a
    LEFT JOIN public.ledger l
      ON l.account_id = a.id
     AND l.organization_id = a.organization_id
   WHERE a.id = expected_account_id
     AND a.organization_id = expected_organization_id
     AND a.name = 'Savings Account'
     AND a.type = 'cash'
     AND a.currency = 'UGX'
     AND a.is_active IS TRUE;

  IF current_balance <> 7000.00 OR company_ledger_rows <> 4 THEN
    RAISE EXCEPTION 'Account balance/ledger rows changed (balance %, rows %); purge cancelled',
      current_balance, company_ledger_rows;
  END IF;

  -- Verify the account still links to exactly the four reviewed transactions.
  SELECT array_agg(DISTINCT le.transaction_id ORDER BY le.transaction_id)
    INTO actual_transaction_ids
    FROM public.ledger_entries le
   WHERE le.account_id = expected_account_id
     AND le.organization_id = expected_organization_id;

  IF actual_transaction_ids IS DISTINCT FROM expected_transaction_ids THEN
    RAISE EXCEPTION 'Linked transaction set changed (%); purge cancelled', actual_transaction_ids;
  END IF;

  IF cardinality(actual_transaction_ids) <> 4 THEN
    RAISE EXCEPTION 'Expected four linked transactions, found %; purge cancelled',
      cardinality(actual_transaction_ids);
  END IF;

  -- Do not allow transaction deletion to cascade into business records. The
  -- ledger entries themselves are intentionally removed with each transaction.
  FOR fk IN
    SELECT c.conrelid::regclass AS referencing_table,
           fa.attname AS referencing_column
      FROM pg_constraint c
      JOIN LATERAL unnest(c.conkey) WITH ORDINALITY fk(attnum, ord) ON TRUE
      JOIN LATERAL unnest(c.confkey) WITH ORDINALITY pk(attnum, ord) USING (ord)
      JOIN pg_attribute fa
        ON fa.attrelid = c.conrelid AND fa.attnum = fk.attnum
      JOIN pg_attribute pa
        ON pa.attrelid = c.confrelid AND pa.attnum = pk.attnum
     WHERE c.contype = 'f'
       AND c.confrelid = 'public.transactions'::regclass
       AND pa.attname = 'id'
       AND c.conrelid <> 'public.ledger_entries'::regclass
  LOOP
    EXECUTE format(
      'SELECT COUNT(*) FROM %s WHERE %I = ANY ($1)',
      fk.referencing_table,
      fk.referencing_column
    ) INTO referenced_rows USING actual_transaction_ids;
    IF referenced_rows > 0 THEN
      RAISE EXCEPTION 'Transactions are referenced by % row(s) in %; purge cancelled',
        referenced_rows, fk.referencing_table;
    END IF;
  END LOOP;

  -- Likewise, refuse to remove the organization account if unrelated records
  -- still reference it. The legacy company ledger rows are removed below.
  FOR fk IN
    SELECT c.conrelid::regclass AS referencing_table,
           fa.attname AS referencing_column
      FROM pg_constraint c
      JOIN LATERAL unnest(c.conkey) WITH ORDINALITY fk(attnum, ord) ON TRUE
      JOIN LATERAL unnest(c.confkey) WITH ORDINALITY pk(attnum, ord) USING (ord)
      JOIN pg_attribute fa
        ON fa.attrelid = c.conrelid AND fa.attnum = fk.attnum
      JOIN pg_attribute pa
        ON pa.attrelid = c.confrelid AND pa.attnum = pk.attnum
     WHERE c.contype = 'f'
       AND c.confrelid = 'public.accounts'::regclass
       AND pa.attname = 'id'
       AND c.conrelid <> 'public.ledger'::regclass
  LOOP
    EXECUTE format(
      'SELECT COUNT(*) FROM %s WHERE %I = $1',
      fk.referencing_table,
      fk.referencing_column
    ) INTO referenced_rows USING expected_account_id;
    IF referenced_rows > 0 THEN
      RAISE EXCEPTION 'Account is referenced by % row(s) in %; purge cancelled',
        referenced_rows, fk.referencing_table;
    END IF;
  END LOOP;

  -- Match the existing account deletion behavior for payment account settings.
  DELETE FROM public.sacco_configurations
   WHERE organization_id = expected_organization_id
     AND config_key IN (
       'payments.marzpay.settlement_account_id',
       'payments.marzpay.reconciliation_account_id'
     )
     AND config_value = to_jsonb(expected_account_id::text);

  DELETE FROM public.ledger
   WHERE account_id = expected_account_id
     AND organization_id = expected_organization_id;
  GET DIAGNOSTICS deleted_ledger_rows = ROW_COUNT;

  -- Deletes each complete atomic transaction; migration 978 cascades its
  -- ledger_entries. This also removes counterpart entries from member accounts.
  DELETE FROM public.transactions
   WHERE id = ANY (actual_transaction_ids)
     AND organization_id = expected_organization_id;
  GET DIAGNOSTICS deleted_transactions = ROW_COUNT;
  IF deleted_transactions <> 4 THEN
    RAISE EXCEPTION 'Expected to delete four transactions, deleted %; purge cancelled',
      deleted_transactions;
  END IF;

  DELETE FROM public.accounts
   WHERE id = expected_account_id
     AND organization_id = expected_organization_id;
  GET DIAGNOSTICS deleted_accounts = ROW_COUNT;
  IF deleted_accounts <> 1 THEN
    RAISE EXCEPTION 'Expected to delete one account, deleted %; purge cancelled', deleted_accounts;
  END IF;

  RAISE NOTICE 'Purged account %, % legacy ledger rows, and % transactions',
    expected_account_id, deleted_ledger_rows, deleted_transactions;
END
$$;

COMMIT;

