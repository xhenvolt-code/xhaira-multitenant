BEGIN;

-- Immutable, effective-dated fee versions. Platform rows have a NULL organization_id;
-- organization rows carry their tenant ID. Keep revenue destinations as references
-- until an accounting policy is approved for both tenant and platform income.
CREATE TABLE IF NOT EXISTS public.transaction_fee_configurations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope VARCHAR(16) NOT NULL CHECK (scope IN ('platform', 'organization')),
  organization_id UUID REFERENCES public.organizations(id) ON DELETE RESTRICT,
  component VARCHAR(16) NOT NULL CHECK (component IN ('sacco', 'xhenvolt', 'marzpay')),
  transaction_type VARCHAR(16) NOT NULL CHECK (transaction_type IN ('deposit', 'withdrawal')),
  version INTEGER NOT NULL CHECK (version > 0),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  basis_points INTEGER NOT NULL DEFAULT 0 CHECK (basis_points BETWEEN 0 AND 10000),
  minimum_fee_minor BIGINT CHECK (minimum_fee_minor IS NULL OR minimum_fee_minor >= 0),
  maximum_fee_minor BIGINT CHECK (maximum_fee_minor IS NULL OR maximum_fee_minor >= 0),
  revenue_destination JSONB NOT NULL DEFAULT '{}'::JSONB,
  effective_from TIMESTAMPTZ NOT NULL,
  effective_to TIMESTAMPTZ,
  change_reason VARCHAR(500) NOT NULL,
  changed_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT transaction_fee_scope_org_check CHECK (
    (scope = 'platform' AND organization_id IS NULL) OR
    (scope = 'organization' AND organization_id IS NOT NULL)
  ),
  CONSTRAINT transaction_fee_max_min_check CHECK (
    maximum_fee_minor IS NULL OR minimum_fee_minor IS NULL OR maximum_fee_minor >= minimum_fee_minor
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_transaction_fee_platform_version
  ON public.transaction_fee_configurations (component, transaction_type, version)
  WHERE scope = 'platform';
CREATE UNIQUE INDEX IF NOT EXISTS uq_transaction_fee_organization_version
  ON public.transaction_fee_configurations (organization_id, component, transaction_type, version)
  WHERE scope = 'organization';

CREATE INDEX IF NOT EXISTS idx_transaction_fee_effective_lookup
  ON public.transaction_fee_configurations
    (scope, organization_id, component, transaction_type, effective_from DESC);

ALTER TABLE public.payment_intents
  ADD COLUMN IF NOT EXISTS fee_calculation JSONB NOT NULL DEFAULT '{}'::JSONB;

COMMIT;
