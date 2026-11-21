-- One-time financial data cleanup for CEVA-CDO.
-- Deletes transactions created through 2026-11-21 18:01 Kampala time
-- (exclusive cutoff 15:02 UTC) for organization b6d28266-756f-4760-acc8-f4ebf5b995a4.
-- Nullable transaction references are cleared to preserve their parent business
-- records. The script aborts if a matching non-nullable reference is found.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.organizations
     WHERE id = 'b6d28266-756f-4760-acc8-f4ebf5b995a4'::uuid
  ) THEN
    RAISE EXCEPTION 'Target organization was not found; no transactions were deleted';
  END IF;
END;
$$;

SELECT set_config('app.organization_id', 'b6d28266-756f-4760-acc8-f4ebf5b995a4', true);
SELECT set_config('app.allow_transaction_delete', 'on', true);

CREATE TEMP TABLE _transactions_to_delete ON COMMIT DROP AS
  SELECT id, organization_id
    FROM public.transactions
   WHERE organization_id = 'b6d28266-756f-4760-acc8-f4ebf5b995a4'::uuid
     AND created_at < TIMESTAMPTZ '2026-11-21 15:02:00+00';

SELECT COUNT(*) AS transactions_to_delete FROM _transactions_to_delete;

-- Preserve parent records by clearing nullable foreign-key columns that point
-- at the transactions being removed. Ledger entries are deleted below.
DO $$
DECLARE
  fk RECORD;
  has_references BOOLEAN;
BEGIN
  FOR fk IN
    SELECT con.conrelid AS child_table,
           child_att.attname AS child_column,
           child_att.attnotnull AS is_not_null
      FROM pg_constraint con
      CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS key_columns(child_num, parent_num, position)
      JOIN pg_attribute child_att
        ON child_att.attrelid = con.conrelid AND child_att.attnum = key_columns.child_num
      JOIN pg_attribute parent_att
        ON parent_att.attrelid = con.confrelid AND parent_att.attnum = key_columns.parent_num
     WHERE con.contype = 'f'
       AND con.confrelid = 'public.transactions'::regclass
       AND parent_att.attname = 'id'
       AND con.conrelid <> 'public.ledger_entries'::regclass
  LOOP
    EXECUTE format(
      'SELECT EXISTS (SELECT 1 FROM %s WHERE %I IN (SELECT id FROM pg_temp._transactions_to_delete))',
      fk.child_table::regclass, fk.child_column
    ) INTO has_references;

    IF has_references AND fk.is_not_null THEN
      RAISE EXCEPTION 'Cannot safely delete: %.% is a non-nullable transaction reference',
        fk.child_table::regclass, fk.child_column;
    ELSIF has_references THEN
      EXECUTE format(
        'UPDATE %s SET %I = NULL WHERE %I IN (SELECT id FROM pg_temp._transactions_to_delete)',
        fk.child_table::regclass, fk.child_column, fk.child_column
      );
    END IF;
  END LOOP;
END;
$$;

ALTER TABLE public.ledger_entries DISABLE TRIGGER USER;
ALTER TABLE public.transactions DISABLE TRIGGER USER;

DELETE FROM public.ledger_entries le
 USING _transactions_to_delete target
 WHERE le.organization_id = target.organization_id
   AND le.transaction_id = target.id;

DELETE FROM public.transactions t
 USING _transactions_to_delete target
 WHERE t.organization_id = target.organization_id
   AND t.id = target.id;

ALTER TABLE public.transactions ENABLE TRIGGER USER;
ALTER TABLE public.ledger_entries ENABLE TRIGGER USER;

COMMIT;
