BEGIN;

ALTER TABLE public.payment_intents
  ALTER COLUMN member_account_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS organization_account_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.payment_intents'::regclass
       AND conname = 'payment_intents_org_organization_account_fkey'
  ) THEN
    ALTER TABLE public.payment_intents
      ADD CONSTRAINT payment_intents_org_organization_account_fkey
      FOREIGN KEY (organization_id, organization_account_id)
      REFERENCES public.accounts (organization_id, id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.payment_intents'::regclass
       AND conname = 'payment_intents_exactly_one_destination_check'
  ) THEN
    ALTER TABLE public.payment_intents
      ADD CONSTRAINT payment_intents_exactly_one_destination_check
      CHECK ((member_account_id IS NULL) <> (organization_account_id IS NULL));
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_payment_intents_org_account
  ON public.payment_intents (organization_id, organization_account_id)
  WHERE organization_account_id IS NOT NULL;

DROP TRIGGER IF EXISTS payment_intents_organization_account_org ON public.payment_intents;
CREATE TRIGGER payment_intents_organization_account_org
  BEFORE INSERT OR UPDATE ON public.payment_intents
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_organization_reference(
    'organization_account_id', 'public', 'accounts', 'id'
  );

COMMIT;
