BEGIN;

DO $$
DECLARE
  fk RECORD;
  definition TEXT;
BEGIN
  IF to_regclass('public.accounts') IS NULL OR to_regclass('public.ledger') IS NULL THEN
    RAISE EXCEPTION 'accounts or ledger table is missing';
  END IF;

  FOR fk IN
    SELECT con.oid, con.conname, con.conrelid, pg_get_constraintdef(con.oid) AS definition
      FROM pg_constraint con
     WHERE con.contype = 'f'
       AND con.confrelid IN ('public.accounts'::regclass, 'public.ledger'::regclass)
  LOOP
    definition := regexp_replace(
      fk.definition,
      ' ON DELETE (NO ACTION|RESTRICT|CASCADE|SET NULL|SET DEFAULT)( \([^)]*\))?',
      ' ON DELETE CASCADE'
    );
    IF definition = fk.definition THEN
      IF position(' ON UPDATE ' IN definition) > 0 THEN
        definition := regexp_replace(definition, ' ON UPDATE ', ' ON DELETE CASCADE ON UPDATE ');
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
