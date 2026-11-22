-- Separate Xhenvolt operator identity and privilege domain for the platform
-- control panel. No institutional users or financial records are rewritten.
BEGIN;

DO $$
DECLARE
  missing_objects TEXT;
BEGIN
  SELECT string_agg(required.name, ', ' ORDER BY required.name)
    INTO missing_objects
    FROM (VALUES
      ('public.organizations', to_regclass('public.organizations') IS NOT NULL),
      ('public.users', to_regclass('public.users') IS NOT NULL),
      ('public.sessions', to_regclass('public.sessions') IS NOT NULL),
      ('public.accounts', to_regclass('public.accounts') IS NOT NULL),
      ('public.members', to_regclass('public.members') IS NOT NULL),
      ('public.ledger', to_regclass('public.ledger') IS NOT NULL),
      ('public.transactions', to_regclass('public.transactions') IS NOT NULL),
      ('public.uq_accounts_id_organization', to_regclass('public.uq_accounts_id_organization') IS NOT NULL),
      ('public.v_account_balances', to_regclass('public.v_account_balances') IS NOT NULL),
      ('public.current_organization_id()', to_regprocedure('public.current_organization_id()') IS NOT NULL),
      ('database role xhaira_runtime', EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xhaira_runtime'))
    ) AS required(name, present)
   WHERE NOT required.present;

  IF missing_objects IS NOT NULL THEN
    RAISE EXCEPTION 'Xhaira schema prerequisites are missing: %. Apply/repair the tenant and finance migrations through 976, then rerun 977.', missing_objects
      USING ERRCODE = 'P0001';
  END IF;
END
$$;

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS institution_type VARCHAR(80) NOT NULL DEFAULT 'sacco';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xhaira_platform_runtime') THEN
    CREATE ROLE xhaira_platform_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;
  ELSE
    ALTER ROLE xhaira_platform_runtime BYPASSRLS;
  END IF;
  EXECUTE format('GRANT xhaira_platform_runtime TO %I', session_user);
END
$$;

CREATE TABLE IF NOT EXISTS public.platform_admins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(160) NOT NULL,
  email VARCHAR(254) NOT NULL,
  password_hash TEXT NOT NULL,
  role VARCHAR(24) NOT NULL DEFAULT 'super_admin' CHECK (role IN ('super_admin', 'analyst', 'viewer')),
  status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'disabled')),
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_admins_email_lower
  ON public.platform_admins (LOWER(email));

CREATE TABLE IF NOT EXISTS public.platform_admin_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id UUID NOT NULL REFERENCES public.platform_admins(id) ON DELETE CASCADE,
  token_hash CHAR(64) NOT NULL UNIQUE,
  ip_address VARCHAR(64),
  user_agent VARCHAR(500),
  expires_at TIMESTAMPTZ NOT NULL,
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_platform_sessions_admin_active
  ON public.platform_admin_sessions (admin_id, expires_at DESC)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS public.platform_login_attempts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email VARCHAR(254) NOT NULL,
  ip_address VARCHAR(64),
  succeeded BOOLEAN NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_platform_login_attempts_email_time
  ON public.platform_login_attempts (LOWER(email), attempted_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_login_attempts_ip_time
  ON public.platform_login_attempts (ip_address, attempted_at DESC)
  WHERE ip_address IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.platform_audit_logs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  admin_id UUID REFERENCES public.platform_admins(id) ON DELETE SET NULL,
  action VARCHAR(100) NOT NULL,
  entity_type VARCHAR(100) NOT NULL,
  entity_id TEXT,
  details JSONB NOT NULL DEFAULT '{}'::JSONB,
  ip_address VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_platform_audit_created
  ON public.platform_audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_audit_entity
  ON public.platform_audit_logs (entity_type, entity_id, created_at DESC);
REVOKE UPDATE, DELETE, TRUNCATE ON public.platform_audit_logs FROM PUBLIC;

CREATE TABLE IF NOT EXISTS public.platform_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  idempotency_key VARCHAR(128) NOT NULL UNIQUE,
  request_fingerprint CHAR(64) NOT NULL,
  operation_type VARCHAR(32) NOT NULL CHECK (operation_type IN (
    'institution_deposit', 'operational_expense', 'operational_advance',
    'reimbursement', 'platform_revenue', 'other'
  )),
  category VARCHAR(80) NOT NULL,
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  currency VARCHAR(3) NOT NULL DEFAULT 'UGX',
  purpose TEXT NOT NULL,
  accounting_treatment TEXT NOT NULL,
  supporting_document_url TEXT,
  institution_account_id UUID,
  institution_transaction_id UUID,
  status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'reversed')),
  created_by UUID NOT NULL REFERENCES public.platform_admins(id) ON DELETE RESTRICT,
  approved_by UUID REFERENCES public.platform_admins(id) ON DELETE RESTRICT,
  approved_at TIMESTAMPTZ,
  decision_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT platform_operation_account_same_org_fkey
    FOREIGN KEY (organization_id, institution_account_id)
    REFERENCES public.accounts(organization_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_platform_operations_org_date
  ON public.platform_operations (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_operations_type_date
  ON public.platform_operations (operation_type, created_at DESC);

-- The default application role stays tenant-scoped. Platform queries use a
-- separate server-only pool that SET ROLEs to this BYPASSRLS role after the
-- platform session has been independently validated.
GRANT USAGE ON SCHEMA public TO xhaira_platform_runtime;
GRANT SELECT ON public.organizations, public.members, public.accounts, public.ledger,
  public.transactions, public.v_account_balances,
  public.platform_admins, public.platform_admin_sessions, public.platform_login_attempts,
  public.platform_operations, public.platform_audit_logs TO xhaira_platform_runtime;
GRANT UPDATE (status, updated_at) ON public.organizations TO xhaira_platform_runtime;
GRANT INSERT ON public.transactions, public.ledger TO xhaira_platform_runtime;
GRANT SELECT, INSERT, UPDATE ON public.platform_admins, public.platform_admin_sessions,
  public.platform_login_attempts, public.platform_operations TO xhaira_platform_runtime;
GRANT SELECT, INSERT ON public.platform_audit_logs TO xhaira_platform_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO xhaira_platform_runtime;

-- Fee analytics are optional when the payment-fee migration has not been
-- installed. The dashboard handles a missing payment_intents relation.
DO $$
BEGIN
  IF to_regclass('public.loans') IS NOT NULL THEN
    GRANT SELECT ON public.loans TO xhaira_platform_runtime;
  END IF;
  IF to_regclass('public.payment_intents') IS NOT NULL THEN
    GRANT SELECT ON public.payment_intents TO xhaira_platform_runtime;
  END IF;
END
$$;

REVOKE ALL ON public.platform_admins, public.platform_admin_sessions,
  public.platform_login_attempts, public.platform_audit_logs, public.platform_operations
  FROM xhaira_runtime, PUBLIC;
GRANT SELECT, INSERT, UPDATE ON public.platform_admins, public.platform_admin_sessions,
  public.platform_login_attempts, public.platform_operations TO xhaira_platform_runtime;
GRANT SELECT, INSERT ON public.platform_audit_logs TO xhaira_platform_runtime;

CREATE OR REPLACE FUNCTION public.organization_status_for_user(p_user_id UUID)
RETURNS TEXT
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT o.status FROM public.users u
  JOIN public.organizations o ON o.id = u.organization_id
  WHERE u.id = p_user_id LIMIT 1
$$;
GRANT EXECUTE ON FUNCTION public.organization_status_for_user(UUID) TO xhaira_runtime;
REVOKE ALL ON FUNCTION public.organization_status_for_user(UUID) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.revoke_organization_sessions(p_organization_id UUID)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE revoked_count INTEGER;
BEGIN
  UPDATE public.sessions SET is_revoked = TRUE
   WHERE organization_id = p_organization_id AND is_revoked = FALSE;
  GET DIAGNOSTICS revoked_count = ROW_COUNT;
  RETURN revoked_count;
END;
$$;
GRANT EXECUTE ON FUNCTION public.revoke_organization_sessions(UUID) TO xhaira_platform_runtime;
REVOKE ALL ON FUNCTION public.revoke_organization_sessions(UUID) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.lookup_session_details(p_session_id UUID)
RETURNS JSONB LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'id', s.id, 'userId', u.id, 'organizationId', s.organization_id,
    'expiresAt', s.expires_at, 'createdAt', s.created_at, 'lastActivity', s.last_activity,
    'inactivityTimeoutMinutes', s.inactivity_timeout_minutes, 'isRevoked', s.is_revoked,
    'deviceName', s.device_name, 'ipAddress', s.ip_address,
    'organizationStatus', o.status,
    'organization', jsonb_build_object('id', o.id, 'name', o.name, 'slug', o.slug),
    'user', jsonb_build_object('id', u.id, 'email', u.email, 'role', u.role, 'status', u.status)
  )
  FROM public.sessions s
  JOIN public.users u ON u.id = s.user_id AND u.organization_id = s.organization_id
  JOIN public.organizations o ON o.id = s.organization_id
  WHERE s.id = p_session_id AND s.expires_at > CURRENT_TIMESTAMP
    AND COALESCE(s.is_revoked, false) = false LIMIT 1
$$;
GRANT EXECUTE ON FUNCTION public.lookup_session_details(UUID) TO xhaira_runtime;
REVOKE ALL ON FUNCTION public.lookup_session_details(UUID) FROM PUBLIC;

-- The platform database role may read existing tables, but future tenant
-- tables are not automatically exposed to it; grant review is required.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM xhaira_platform_runtime;

COMMIT;
