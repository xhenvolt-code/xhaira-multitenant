BEGIN;

ALTER TABLE public.company_branding
  ADD COLUMN IF NOT EXISTS sidebar_app_name_mode TEXT NOT NULL DEFAULT 'xhaira',
  ADD COLUMN IF NOT EXISTS logo_url TEXT;

ALTER TABLE public.company_branding
  DROP CONSTRAINT IF EXISTS company_branding_sidebar_app_name_mode_check;

ALTER TABLE public.company_branding
  ADD CONSTRAINT company_branding_sidebar_app_name_mode_check
  CHECK (sidebar_app_name_mode IN ('xhaira', 'organization_name', 'organization_code'));

UPDATE public.company_branding
   SET sidebar_app_name_mode = CASE
     WHEN use_organization_name_as_app_name THEN 'organization_name'
     ELSE 'xhaira'
   END;

COMMIT;
