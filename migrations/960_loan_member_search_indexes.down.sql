BEGIN;

DROP INDEX IF EXISTS public.idx_members_org_active_phone_prefix;
DROP INDEX IF EXISTS public.idx_members_org_active_number_prefix;
DROP INDEX IF EXISTS public.idx_members_org_active_name_prefix;

COMMIT;
