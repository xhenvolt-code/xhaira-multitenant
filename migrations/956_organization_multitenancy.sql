BEGIN;

CREATE TABLE public.organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(255) NOT NULL UNIQUE,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION public.current_organization_id()
RETURNS UUID
LANGUAGE SQL
STABLE
AS $$
  SELECT NULLIF(current_setting('app.organization_id', true), '')::UUID
$$;

CREATE OR REPLACE FUNCTION public.enforce_same_organization_reference()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  referenced_id UUID;
  referenced_organization_id UUID;
BEGIN
  referenced_id := NULLIF(to_jsonb(NEW) ->> TG_ARGV[0], '')::UUID;
  IF referenced_id IS NULL THEN RETURN NEW; END IF;

  EXECUTE format('SELECT organization_id FROM %I.%I WHERE %I = $1', TG_ARGV[1], TG_ARGV[2], TG_ARGV[3])
    INTO referenced_organization_id USING referenced_id;

  IF referenced_organization_id IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'Referenced record must belong to the same organization' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE public.ledger_entries DISABLE TRIGGER trg_ledger_entries_immutable;
ALTER TABLE public.transactions DISABLE TRIGGER trg_transactions_immutable;

DO $$
DECLARE
  org_name TEXT;
  org_slug TEXT;
  org_id UUID;
  tenant_table TEXT;
BEGIN
  SELECT NULLIF(BTRIM(organization_name), ''), NULLIF(BTRIM(organization_slug), '')
    INTO org_name, org_slug FROM public.company_branding ORDER BY created_at LIMIT 1;
  org_name := COALESCE(org_name, 'Xhaira SACCO');
  org_slug := COALESCE(NULLIF(TRIM(BOTH '-' FROM LOWER(REGEXP_REPLACE(org_name, '[^a-zA-Z0-9]+', '-', 'g'))), ''), 'xhaira-sacco');

  INSERT INTO public.organizations (name, slug)
  VALUES (org_name, org_slug)
  ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
  RETURNING id INTO org_id;

  FOR tenant_table IN
    SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       AND table_name NOT IN ('organizations', 'permissions', 'platform_modules', 'role_permissions', 'roles', 'system_pricing_plans')
     ORDER BY table_name
  LOOP
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN organization_id UUID', tenant_table);
    EXECUTE format('UPDATE public.%I SET organization_id = $1', tenant_table) USING org_id;
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN organization_id SET DEFAULT public.current_organization_id()', tenant_table);
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN organization_id SET NOT NULL', tenant_table);
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT', tenant_table, tenant_table || '_organization_id_fkey');
    EXECUTE format('CREATE INDEX %I ON public.%I (organization_id)', 'idx_' || tenant_table || '_organization_id', tenant_table);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tenant_table);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', tenant_table);
    EXECUTE format('CREATE POLICY organization_isolation ON public.%I USING (organization_id = public.current_organization_id()) WITH CHECK (organization_id = public.current_organization_id())', tenant_table);
  END LOOP;
END;
$$;

ALTER TABLE public.ledger_entries ENABLE TRIGGER trg_ledger_entries_immutable;
ALTER TABLE public.transactions ENABLE TRIGGER trg_transactions_immutable;

DROP INDEX IF EXISTS public.uq_company_branding_active;
ALTER TABLE public.company_branding DROP CONSTRAINT IF EXISTS company_branding_organization_slug_key;
CREATE UNIQUE INDEX uq_company_branding_organization_active ON public.company_branding (organization_id) WHERE is_active;
CREATE UNIQUE INDEX uq_company_branding_organization_slug ON public.company_branding (organization_id, organization_slug);

ALTER VIEW public.v_account_balances SET (security_invoker = true);
ALTER VIEW public.v_member_account_balances SET (security_invoker = true);
ALTER VIEW public.v_member_shares SET (security_invoker = true);

DO $$
DECLARE
  fk RECORD;
  local_column TEXT;
  target_column TEXT;
  target_schema TEXT;
  target_table TEXT;
  trigger_name TEXT;
BEGIN
  FOR fk IN
    SELECT con.oid, con.conname, con.conrelid, con.confrelid,
           con.conkey[1] AS local_attnum, con.confkey[1] AS target_attnum,
           con.conrelid::regclass::TEXT AS local_table
      FROM pg_constraint con
     WHERE con.contype = 'f' AND array_length(con.conkey, 1) = 1
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = con.conrelid AND a.attnum = con.conkey[1] AND a.atttypid = 'uuid'::regtype)
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = con.confrelid AND a.attnum = con.confkey[1] AND a.attname = 'id' AND a.atttypid = 'uuid'::regtype)
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = con.conrelid AND a.attname = 'organization_id' AND a.attnum > 0 AND NOT a.attisdropped)
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = con.confrelid AND a.attname = 'organization_id' AND a.attnum > 0 AND NOT a.attisdropped)
  LOOP
    SELECT attname INTO local_column FROM pg_attribute WHERE attrelid = fk.conrelid AND attnum = fk.local_attnum;
    SELECT attname INTO target_column FROM pg_attribute WHERE attrelid = fk.confrelid AND attnum = fk.target_attnum;
    SELECT n.nspname, c.relname INTO target_schema, target_table FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = fk.confrelid;
    trigger_name := left('org_ref_' || fk.conname, 63);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION public.enforce_same_organization_reference(%L, %L, %L, %L)',
      trigger_name, fk.local_table, local_column, target_schema, target_table, target_column);
  END LOOP;
END;
$$;

ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_read ON public.organizations FOR SELECT USING (id = public.current_organization_id());
CREATE POLICY organization_update ON public.organizations FOR UPDATE USING (id = public.current_organization_id()) WITH CHECK (id = public.current_organization_id());

CREATE OR REPLACE FUNCTION public.organization_id_for_session(p_session_id UUID)
RETURNS UUID LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT s.organization_id FROM public.sessions s JOIN public.users u ON u.id = s.user_id AND u.organization_id = s.organization_id
   WHERE s.id = p_session_id AND s.expires_at > CURRENT_TIMESTAMP AND COALESCE(s.is_revoked, false) = false LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.lookup_session_details(p_session_id UUID)
RETURNS JSONB LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object('id', s.id, 'userId', u.id, 'organizationId', s.organization_id,
    'expiresAt', s.expires_at, 'createdAt', s.created_at, 'lastActivity', s.last_activity,
    'inactivityTimeoutMinutes', s.inactivity_timeout_minutes, 'isRevoked', s.is_revoked,
    'deviceName', s.device_name, 'ipAddress', s.ip_address,
    'organization', jsonb_build_object('id', o.id, 'name', o.name, 'slug', o.slug),
    'user', jsonb_build_object('id', u.id, 'email', u.email, 'role', u.role, 'status', u.status))
  FROM public.sessions s
  JOIN public.users u ON u.id = s.user_id AND u.organization_id = s.organization_id
  JOIN public.organizations o ON o.id = s.organization_id
  WHERE s.id = p_session_id AND s.expires_at > CURRENT_TIMESTAMP AND COALESCE(s.is_revoked, false) = false LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.lookup_login_user(p_email TEXT)
RETURNS SETOF public.users LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT u.* FROM public.users u WHERE LOWER(u.email) = LOWER(p_email) LIMIT 1 $$;

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

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xhaira_runtime') THEN
    CREATE ROLE xhaira_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  EXECUTE format('GRANT xhaira_runtime TO %I', session_user);
END;
$$;

GRANT USAGE ON SCHEMA public TO xhaira_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO xhaira_runtime;
REVOKE INSERT, DELETE ON public.organizations FROM xhaira_runtime;
GRANT SELECT, UPDATE ON public.organizations TO xhaira_runtime;
REVOKE INSERT, UPDATE, DELETE ON public.permissions, public.platform_modules,
  public.role_permissions, public.roles, public.system_pricing_plans FROM xhaira_runtime;
GRANT SELECT ON public.permissions, public.platform_modules,
  public.role_permissions, public.roles, public.system_pricing_plans TO xhaira_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO xhaira_runtime;
GRANT EXECUTE ON FUNCTION public.current_organization_id() TO xhaira_runtime;
GRANT EXECUTE ON FUNCTION public.enforce_same_organization_reference() TO xhaira_runtime;
GRANT EXECUTE ON FUNCTION public.organization_id_for_session(UUID) TO xhaira_runtime;
GRANT EXECUTE ON FUNCTION public.lookup_session_details(UUID) TO xhaira_runtime;
GRANT EXECUTE ON FUNCTION public.lookup_login_user(TEXT) TO xhaira_runtime;
GRANT EXECUTE ON FUNCTION public.create_organization_owner(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO xhaira_runtime;
REVOKE ALL ON FUNCTION public.organization_id_for_session(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lookup_session_details(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lookup_login_user(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_organization_owner(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO xhaira_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO xhaira_runtime;

COMMIT;