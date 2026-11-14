BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.member_accounts
     WHERE account_type NOT IN ('savings', 'loan', 'investment', 'shares', 'fixed_deposit')
  ) THEN
    RAISE EXCEPTION 'Rollback stopped: migrate configured account-type accounts before restoring the legacy constraint';
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS member_accounts_validate_type ON public.member_accounts;
DROP FUNCTION IF EXISTS public.validate_member_account_type();

ALTER TABLE public.member_accounts
  DROP CONSTRAINT IF EXISTS member_accounts_account_type_check;
ALTER TABLE public.member_accounts
  ADD CONSTRAINT member_accounts_account_type_check
  CHECK (account_type IN ('savings', 'loan', 'investment', 'shares', 'fixed_deposit'));

COMMIT;
