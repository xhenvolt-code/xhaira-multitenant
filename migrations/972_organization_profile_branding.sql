BEGIN;

ALTER TABLE public.company_branding
  ADD COLUMN IF NOT EXISTS contact_phones TEXT,
  ADD COLUMN IF NOT EXISTS contact_email TEXT,
  ADD COLUMN IF NOT EXISTS website TEXT,
  ADD COLUMN IF NOT EXISTS address TEXT,
  ADD COLUMN IF NOT EXISTS use_organization_name_as_app_name BOOLEAN NOT NULL DEFAULT false;

UPDATE public.company_branding cb
   SET organization_name = o.name
  FROM public.organizations o
 WHERE cb.organization_id = o.id
   AND NULLIF(BTRIM(cb.organization_name), '') IS NULL;

COMMIT;
