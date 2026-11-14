BEGIN;

-- Configuration rows must be independently editable by each SACCO.
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT con.conname, con.conrelid::regclass AS table_name
      FROM pg_constraint con
     WHERE con.conrelid IN ('public.sacco_configurations'::regclass, 'public.member_field_configs'::regclass)
       AND con.contype = 'u'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', c.table_name, c.conname);
  END LOOP;
  -- Older installations may implement uniqueness as unique indexes.
  DROP INDEX IF EXISTS public.sacco_configurations_config_key_key;
  DROP INDEX IF EXISTS public.member_field_configs_field_name_key;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_sacco_configurations_org_key
  ON public.sacco_configurations (organization_id, config_key);
CREATE UNIQUE INDEX IF NOT EXISTS uq_member_field_configs_org_field
  ON public.member_field_configs (organization_id, field_name);

-- Keep existing member identities stable; custom fields extend the current model.
ALTER TABLE public.members
  ADD COLUMN IF NOT EXISTS custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS member_kind VARCHAR(20) NOT NULL DEFAULT 'individual'
    CHECK (member_kind IN ('individual', 'group'));

ALTER TABLE public.member_field_configs
  ADD COLUMN IF NOT EXISTS validation_rules JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS public.member_configuration_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL DEFAULT public.current_organization_id()
    REFERENCES public.organizations(id) ON DELETE RESTRICT,
  setting_type VARCHAR(40) NOT NULL CHECK (setting_type IN ('sacco_config', 'member_field', 'document_type')),
  setting_key VARCHAR(200) NOT NULL,
  old_value JSONB,
  new_value JSONB NOT NULL,
  changed_by UUID REFERENCES public.users(id),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_member_configuration_audit_org_time
  ON public.member_configuration_audit (organization_id, changed_at DESC);
ALTER TABLE public.member_configuration_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_configuration_audit FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS organization_isolation ON public.member_configuration_audit;
CREATE POLICY organization_isolation ON public.member_configuration_audit
  USING (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());
CREATE TRIGGER member_configuration_audit_user_same_org
  BEFORE INSERT OR UPDATE ON public.member_configuration_audit
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_organization_reference('changed_by', 'public', 'users', 'id');
GRANT SELECT, INSERT ON public.member_configuration_audit TO xhaira_runtime;

CREATE TABLE IF NOT EXISTS public.member_document_type_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL DEFAULT public.current_organization_id()
    REFERENCES public.organizations(id) ON DELETE RESTRICT,
  document_key VARCHAR(100) NOT NULL,
  label VARCHAR(200) NOT NULL,
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  is_required BOOLEAN NOT NULL DEFAULT false,
  accepted_mime_types JSONB NOT NULL DEFAULT '[]'::jsonb,
  max_size_bytes BIGINT NOT NULL DEFAULT 10485760 CHECK (max_size_bytes > 0),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, document_key)
);
CREATE INDEX IF NOT EXISTS idx_member_document_type_configs_org
  ON public.member_document_type_configs (organization_id, sort_order);
ALTER TABLE public.member_document_type_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_document_type_configs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS organization_isolation ON public.member_document_type_configs;
CREATE POLICY organization_isolation ON public.member_document_type_configs
  USING (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

CREATE TABLE IF NOT EXISTS public.member_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL DEFAULT public.current_organization_id()
    REFERENCES public.organizations(id) ON DELETE RESTRICT,
  member_id UUID NOT NULL REFERENCES public.members(id) ON DELETE CASCADE,
  document_key VARCHAR(100) NOT NULL,
  original_filename VARCHAR(255) NOT NULL,
  mime_type VARCHAR(150) NOT NULL,
  file_size BIGINT NOT NULL CHECK (file_size > 0),
  cloudinary_account VARCHAR(100) NOT NULL,
  public_id VARCHAR(500) NOT NULL,
  resource_type VARCHAR(20) NOT NULL CHECK (resource_type IN ('image', 'raw')),
  uploaded_by UUID NOT NULL REFERENCES public.users(id),
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, cloudinary_account, public_id)
);
CREATE INDEX IF NOT EXISTS idx_member_documents_org_member
  ON public.member_documents (organization_id, member_id, uploaded_at DESC);
ALTER TABLE public.member_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_isolation ON public.member_documents
  USING (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());
CREATE TRIGGER member_documents_member_same_org
  BEFORE INSERT OR UPDATE ON public.member_documents
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_organization_reference('member_id', 'public', 'members', 'id');
CREATE TRIGGER member_documents_uploader_same_org
  BEFORE INSERT OR UPDATE ON public.member_documents
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_organization_reference('uploaded_by', 'public', 'users', 'id');

CREATE OR REPLACE FUNCTION public.seed_member_configuration_defaults(p_organization_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_organization_id IS NULL OR p_organization_id IS DISTINCT FROM public.current_organization_id() THEN
    RAISE EXCEPTION 'Member defaults can only be seeded for the active organization';
  END IF;
  INSERT INTO public.sacco_configurations
    (organization_id, config_key, config_value, config_type, category, label, description)
  VALUES
    (p_organization_id, 'groups.requirement', '"optional"', 'text', 'members', 'Group requirement', 'Policy for group membership during member registration'),
    (p_organization_id, 'groups.nature', '"member_type"', 'text', 'members', 'Group nature', 'Whether groups are members, sub-organizations, or both'),
    (p_organization_id, 'groups.cardinality', '"one"', 'text', 'members', 'Group membership cardinality', 'Maximum groups linked to each individual')
  ON CONFLICT (organization_id, config_key) DO NOTHING;

  INSERT INTO public.member_field_configs
    (organization_id, field_name, label, section, field_type, is_active, is_required, sort_order, options, validation_rules)
  VALUES
    (p_organization_id, 'first_name', 'First Name', 'personal', 'text', true, true, 1, NULL, '{}'::jsonb),
    (p_organization_id, 'last_name', 'Last Name', 'personal', 'text', true, true, 2, NULL, '{}'::jsonb),
    (p_organization_id, 'other_name', 'Other/Middle Name', 'personal', 'text', true, false, 3, NULL, '{}'::jsonb),
    (p_organization_id, 'gender', 'Gender', 'personal', 'select', true, true, 4, '["male","female","other"]'::jsonb, '{}'::jsonb),
    (p_organization_id, 'date_of_birth', 'Date of Birth', 'personal', 'date', true, true, 5, NULL, '{}'::jsonb),
    (p_organization_id, 'photo_url', 'Profile Photo', 'identification', 'file', false, false, 6, NULL, '{}'::jsonb),
    (p_organization_id, 'national_id', 'National ID Number', 'identification', 'text', true, true, 7, NULL, '{}'::jsonb),
    (p_organization_id, 'id_type', 'ID Type', 'identification', 'select', true, false, 8, '["national_id","passport","other"]'::jsonb, '{}'::jsonb),
    (p_organization_id, 'id_photo_url', 'ID Document Photo', 'identification', 'file', false, false, 9, NULL, '{}'::jsonb),
    (p_organization_id, 'email', 'Email Address', 'contact', 'email', true, false, 10, NULL, '{}'::jsonb),
    (p_organization_id, 'phone', 'Phone Number', 'contact', 'phone', true, true, 11, NULL, '{}'::jsonb),
    (p_organization_id, 'address', 'Home Address', 'contact', 'textarea', true, false, 12, NULL, '{}'::jsonb),
    (p_organization_id, 'occupation', 'Occupation / Job Title', 'employment', 'text', false, false, 13, NULL, '{}'::jsonb),
    (p_organization_id, 'employer', 'Employer / Business Name', 'employment', 'text', false, false, 14, NULL, '{}'::jsonb),
    (p_organization_id, 'monthly_income', 'Monthly Income', 'employment', 'number', false, false, 15, NULL, '{}'::jsonb),
    (p_organization_id, 'next_of_kin_name', 'Next of Kin - Full Name', 'kin', 'text', false, false, 16, NULL, '{}'::jsonb),
    (p_organization_id, 'next_of_kin_phone', 'Next of Kin - Phone', 'kin', 'phone', false, false, 17, NULL, '{}'::jsonb),
    (p_organization_id, 'next_of_kin_relationship', 'Next of Kin - Relationship', 'kin', 'text', false, false, 18, NULL, '{}'::jsonb),
    (p_organization_id, 'emergency_contact_name', 'Emergency Contact - Name', 'kin', 'text', false, false, 19, NULL, '{}'::jsonb),
    (p_organization_id, 'emergency_contact_phone', 'Emergency Contact - Phone', 'kin', 'phone', false, false, 20, NULL, '{}'::jsonb),
    (p_organization_id, 'notes', 'Additional Notes', 'other', 'textarea', false, false, 21, NULL, '{}'::jsonb)
  ON CONFLICT (organization_id, field_name) DO UPDATE SET options = COALESCE(member_field_configs.options, EXCLUDED.options);

  INSERT INTO public.member_document_type_configs
    (organization_id, document_key, label, is_enabled, is_required, accepted_mime_types, max_size_bytes, sort_order)
  VALUES
    (p_organization_id, 'national_id_front', 'National ID front', true, false, '["image/jpeg","image/png","application/pdf"]', 10485760, 1),
    (p_organization_id, 'national_id_back', 'National ID back', true, false, '["image/jpeg","image/png","application/pdf"]', 10485760, 2),
    (p_organization_id, 'introduction_letter', 'Introduction letter', false, false, '["application/pdf","image/jpeg","image/png"]', 10485760, 3)
  ON CONFLICT (organization_id, document_key) DO NOTHING;
END $$;

REVOKE ALL ON FUNCTION public.seed_member_configuration_defaults(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.seed_member_configuration_defaults(UUID) TO xhaira_runtime;

CREATE OR REPLACE FUNCTION public.create_organization_owner(p_organization_name TEXT, p_organization_slug TEXT, p_email TEXT, p_password_hash TEXT, p_name TEXT, p_username TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
  PERFORM public.seed_member_configuration_defaults(new_org_id);
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

CREATE TABLE IF NOT EXISTS public.member_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL DEFAULT public.current_organization_id()
    REFERENCES public.organizations(id) ON DELETE RESTRICT,
  group_member_id UUID REFERENCES public.members(id) ON DELETE CASCADE,
  group_name VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, group_member_id)
);
CREATE TABLE IF NOT EXISTS public.member_group_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL DEFAULT public.current_organization_id()
    REFERENCES public.organizations(id) ON DELETE RESTRICT,
  group_id UUID NOT NULL REFERENCES public.member_groups(id) ON DELETE CASCADE,
  member_id UUID NOT NULL REFERENCES public.members(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, group_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_member_group_links_org_member
  ON public.member_group_links (organization_id, member_id);
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['member_groups','member_group_links'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY organization_isolation ON public.%I USING (organization_id = public.current_organization_id()) WITH CHECK (organization_id = public.current_organization_id())', t);
  END LOOP;
END $$;

-- Explicit same-tenant checks for the new group relationships. The generic
-- tenancy migration only attached reference triggers to tables present then.
CREATE TRIGGER member_groups_same_org
  BEFORE INSERT OR UPDATE ON public.member_groups
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_organization_reference('group_member_id', 'public', 'members', 'id');
CREATE TRIGGER member_group_links_group_same_org
  BEFORE INSERT OR UPDATE ON public.member_group_links
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_organization_reference('group_id', 'public', 'member_groups', 'id');
CREATE TRIGGER member_group_links_member_same_org
  BEFORE INSERT OR UPDATE ON public.member_group_links
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_organization_reference('member_id', 'public', 'members', 'id');

CREATE OR REPLACE FUNCTION public.enforce_member_group_policy()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE cardinality_policy TEXT; member_kind_value TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text || ':' || NEW.member_id::text, 0));
  SELECT config_value #>> '{}' INTO cardinality_policy
    FROM public.sacco_configurations
   WHERE organization_id = NEW.organization_id AND config_key = 'groups.cardinality';
  SELECT member_kind INTO member_kind_value FROM public.members
   WHERE id = NEW.member_id AND organization_id = NEW.organization_id;
  IF member_kind_value IS DISTINCT FROM 'individual' THEN
    RAISE EXCEPTION 'Only individual members can be linked into a group';
  END IF;
  IF COALESCE(cardinality_policy, 'one') = 'one' AND EXISTS (
    SELECT 1 FROM public.member_group_links l
     WHERE l.organization_id = NEW.organization_id AND l.member_id = NEW.member_id
       AND l.id <> NEW.id
  ) THEN
    RAISE EXCEPTION 'Member can belong to only one group under this organization policy';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER member_group_links_policy
  BEFORE INSERT OR UPDATE ON public.member_group_links
  FOR EACH ROW EXECUTE FUNCTION public.enforce_member_group_policy();

GRANT SELECT, INSERT, UPDATE, DELETE ON public.member_document_type_configs,
  public.member_groups, public.member_group_links, public.member_documents TO xhaira_runtime;

COMMIT;

