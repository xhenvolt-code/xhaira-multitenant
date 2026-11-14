BEGIN;

-- This rollback preserves organization-scoped unique keys. Restoring the old
-- global keys would make valid tenant-specific settings collide.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.member_documents) THEN
    RAISE EXCEPTION 'Rollback stopped: export or remove member_documents before removing private document storage';
  END IF;
  IF EXISTS (SELECT 1 FROM public.member_groups) OR EXISTS (SELECT 1 FROM public.member_group_links) THEN
    RAISE EXCEPTION 'Rollback stopped: migrate group records and memberships before removing group tables';
  END IF;
  IF EXISTS (SELECT 1 FROM public.member_configuration_audit) THEN
    RAISE EXCEPTION 'Rollback stopped: export configuration audit history before removing it';
  END IF;
  IF EXISTS (SELECT 1 FROM public.members WHERE member_kind <> 'individual' OR custom_fields <> '{}'::jsonb) THEN
    RAISE EXCEPTION 'Rollback stopped: migrate group identities and custom member values before removing member columns';
  END IF;
  IF EXISTS (SELECT 1 FROM public.member_field_configs WHERE field_name NOT IN (
    'first_name','last_name','other_name','gender','date_of_birth','photo_url','national_id','id_type','id_photo_url',
    'email','phone','address','occupation','employer','monthly_income','next_of_kin_name','next_of_kin_phone',
    'next_of_kin_relationship','emergency_contact_name','emergency_contact_phone','notes')) THEN
    RAISE EXCEPTION 'Rollback stopped: migrate custom member field definitions before removing them';
  END IF;
  IF EXISTS (SELECT 1 FROM public.member_field_configs WHERE validation_rules <> '{}'::jsonb) THEN
    RAISE EXCEPTION 'Rollback stopped: migrate configured validation rules before removing them';
  END IF;
  IF EXISTS (SELECT 1 FROM public.member_document_type_configs WHERE
      (document_key = 'national_id_front' AND (label <> 'National ID front' OR is_enabled <> true OR is_required <> false OR accepted_mime_types <> '["image/jpeg","image/png","application/pdf"]'::jsonb OR max_size_bytes <> 10485760)) OR
      (document_key = 'national_id_back' AND (label <> 'National ID back' OR is_enabled <> true OR is_required <> false OR accepted_mime_types <> '["image/jpeg","image/png","application/pdf"]'::jsonb OR max_size_bytes <> 10485760)) OR
      (document_key = 'introduction_letter' AND (label <> 'Introduction letter' OR is_enabled <> false OR is_required <> false OR accepted_mime_types <> '["application/pdf","image/jpeg","image/png"]'::jsonb OR max_size_bytes <> 10485760)) OR
      document_key NOT IN ('national_id_front','national_id_back','introduction_letter')) THEN
    RAISE EXCEPTION 'Rollback stopped: migrate changed document type settings before removing them';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.create_organization_owner(p_organization_name TEXT, p_organization_slug TEXT, p_email TEXT, p_password_hash TEXT, p_name TEXT, p_username TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE new_org_id UUID; new_user_id UUID; role_id UUID;
BEGIN
  IF NULLIF(BTRIM(p_organization_name), '') IS NULL OR NULLIF(BTRIM(p_email), '') IS NULL
     OR NULLIF(BTRIM(p_name), '') IS NULL OR NULLIF(BTRIM(p_password_hash), '') IS NULL THEN
    RAISE EXCEPTION 'Organization name, email, name, and password are required';
  END IF;
  INSERT INTO public.organizations (name, slug) VALUES (BTRIM(p_organization_name), p_organization_slug) RETURNING id INTO new_org_id;
  SELECT id INTO role_id FROM public.roles WHERE name = 'superadmin' LIMIT 1;
  IF role_id IS NULL THEN
    INSERT INTO public.roles (id, name, description, is_system_role)
    VALUES (gen_random_uuid(), 'superadmin', 'Organization super administrator', true) RETURNING id INTO role_id;
  END IF;
  PERFORM set_config('app.organization_id', new_org_id::TEXT, true);
  INSERT INTO public.users (email, password_hash, name, username, role, role_id, is_superadmin, is_active, status, organization_id, created_at, updated_at)
  VALUES (LOWER(BTRIM(p_email)), p_password_hash, BTRIM(p_name), p_username, 'superadmin', role_id, true, true, 'active', new_org_id, NOW(), NOW())
  RETURNING id INTO new_user_id;
  INSERT INTO public.company_branding (organization_name, organization_slug, is_active, updated_by, organization_id)
  VALUES (BTRIM(p_organization_name), p_organization_slug, true, new_user_id, new_org_id);
  RETURN jsonb_build_object('id', new_user_id, 'email', LOWER(BTRIM(p_email)), 'name', BTRIM(p_name), 'username', p_username,
    'role', 'superadmin', 'status', 'active', 'organizationId', new_org_id, 'organizationName', BTRIM(p_organization_name), 'isFirstUser', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.create_organization_owner(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO xhaira_runtime;

DROP FUNCTION IF EXISTS public.enforce_member_group_policy();
DROP FUNCTION IF EXISTS public.seed_member_configuration_defaults(UUID);
DROP TABLE public.member_documents;
DROP TABLE public.member_group_links;
DROP TABLE public.member_groups;
DROP TABLE public.member_document_type_configs;
DROP TABLE public.member_configuration_audit;
ALTER TABLE public.member_field_configs DROP COLUMN validation_rules;
ALTER TABLE public.members DROP COLUMN custom_fields, DROP COLUMN member_kind;

COMMIT;
