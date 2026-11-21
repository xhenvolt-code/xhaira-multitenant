BEGIN;

DO $$
BEGIN
  IF to_regclass('public.payment_intents') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xhaira_runtime') THEN
    RAISE EXCEPTION 'payment_intents or xhaira_runtime is missing';
  END IF;
END;
$$;

-- Account force deletion may remove terminal payment requests that reference it.
-- RLS on payment_intents continues to restrict deletes to the active organization.
GRANT DELETE ON public.payment_intents TO xhaira_runtime;

COMMIT;
