BEGIN;

-- The account_type_id FK is the configured source of truth. Preserve the five
-- legacy categories for older records, while allowing a configured account
-- type's lowercase code for newly-created account products.
ALTER TABLE public.member_accounts
  DROP CONSTRAINT IF EXISTS member_accounts_account_type_check;

ALTER TABLE public.member_accounts
  ADD CONSTRAINT member_accounts_account_type_check
  CHECK (
    account_type IN ('savings', 'loan', 'investment', 'shares', 'fixed_deposit')
    OR account_type_id IS NOT NULL
  );

CREATE OR REPLACE FUNCTION public.validate_member_account_type()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  configured_code TEXT;
  canonical_type TEXT;
BEGIN
  IF NEW.account_type_id IS NULL THEN
    IF NEW.account_type NOT IN ('savings', 'loan', 'investment', 'shares', 'fixed_deposit') THEN
      RAISE EXCEPTION 'A configured account type is required for account type "%"', NEW.account_type;
    END IF;
    RETURN NEW;
  END IF;

  SELECT UPPER(code) INTO configured_code
    FROM public.account_types
   WHERE id = NEW.account_type_id;
  IF configured_code IS NULL THEN
    RAISE EXCEPTION 'Configured account type was not found';
  END IF;

  canonical_type := CASE configured_code
    WHEN 'VOL_SAV' THEN 'savings'
    WHEN 'FIXED_SAV' THEN 'fixed_deposit'
    WHEN 'FIXED_DEP' THEN 'fixed_deposit'
    WHEN 'SHARES' THEN 'shares'
    WHEN 'LOAN_ACC' THEN 'loan'
    WHEN 'INVEST' THEN 'investment'
    ELSE LOWER(configured_code)
  END;

  IF NEW.account_type IS DISTINCT FROM canonical_type THEN
    RAISE EXCEPTION 'Account type "%" does not match configured account type "%"',
      NEW.account_type, configured_code;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS member_accounts_validate_type ON public.member_accounts;
CREATE TRIGGER member_accounts_validate_type
  BEFORE INSERT OR UPDATE OF account_type, account_type_id
  ON public.member_accounts
  FOR EACH ROW EXECUTE FUNCTION public.validate_member_account_type();

REVOKE ALL ON FUNCTION public.validate_member_account_type() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.validate_member_account_type() TO xhaira_runtime;

COMMIT;
