BEGIN;

REVOKE ALL ON public.transaction_fee_configurations FROM PUBLIC, xhaira_runtime;
GRANT SELECT, INSERT, UPDATE ON public.transaction_fee_configurations TO xhaira_platform_runtime;
REVOKE DELETE, TRUNCATE ON public.transaction_fee_configurations FROM xhaira_platform_runtime;

COMMIT;
