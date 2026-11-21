BEGIN;

CREATE OR REPLACE FUNCTION public.guard_immutable_financial_rows()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Financial transaction records are immutable; post a correcting transaction instead.';
  END IF;

  IF current_setting('app.allow_transaction_delete', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Transactions are immutable and cannot be deleted. Post a reversal instead.';
  END IF;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_transactions_immutable ON public.transactions;
DROP TRIGGER IF EXISTS trg_transactions_immutable_update ON public.transactions;
CREATE TRIGGER trg_transactions_immutable
  BEFORE DELETE ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.guard_immutable_financial_rows();
CREATE TRIGGER trg_transactions_immutable_update
  BEFORE UPDATE ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.guard_immutable_financial_rows();

DROP TRIGGER IF EXISTS trg_ledger_entries_immutable ON public.ledger_entries;
DROP TRIGGER IF EXISTS trg_ledger_entries_immutable_update ON public.ledger_entries;
CREATE TRIGGER trg_ledger_entries_immutable
  BEFORE DELETE ON public.ledger_entries
  FOR EACH ROW EXECUTE FUNCTION public.guard_immutable_financial_rows();
CREATE TRIGGER trg_ledger_entries_immutable_update
  BEFORE UPDATE ON public.ledger_entries
  FOR EACH ROW EXECUTE FUNCTION public.guard_immutable_financial_rows();

DO $$
DECLARE
  fk RECORD;
  definition TEXT;
BEGIN
  FOR fk IN
    SELECT con.conname, con.conrelid, pg_get_constraintdef(con.oid) AS definition
      FROM pg_constraint con
     WHERE con.contype = 'f'
       AND con.confrelid = 'public.transactions'::regclass
  LOOP
    definition := regexp_replace(
      fk.definition,
      ' ON DELETE (NO ACTION|RESTRICT|CASCADE|SET NULL|SET DEFAULT)( \([^)]*\))?',
      ' ON DELETE CASCADE'
    );
    IF definition = fk.definition THEN
      IF position(' ON UPDATE ' IN definition) > 0 THEN
        definition := regexp_replace(definition, ' ON UPDATE ', ' ON DELETE CASCADE ON UPDATE ');
      ELSIF position(' NOT DEFERRABLE' IN definition) > 0 THEN
        definition := regexp_replace(definition, ' NOT DEFERRABLE', ' ON DELETE CASCADE NOT DEFERRABLE');
      ELSIF position(' DEFERRABLE' IN definition) > 0 THEN
        definition := regexp_replace(definition, ' DEFERRABLE', ' ON DELETE CASCADE DEFERRABLE');
      ELSE
        definition := definition || ' ON DELETE CASCADE';
      END IF;
    END IF;

    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', fk.conrelid::regclass, fk.conname);
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s', fk.conrelid::regclass, fk.conname, definition);
  END LOOP;
END;
$$;

COMMIT;
