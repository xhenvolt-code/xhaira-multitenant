BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS uq_accounts_organization_id_id
  ON public.accounts (organization_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_member_accounts_organization_id_id
  ON public.member_accounts (organization_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_transactions_organization_id_id
  ON public.transactions (organization_id, id);

CREATE TABLE public.payment_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL DEFAULT public.current_organization_id(),
  idempotency_key VARCHAR(128) NOT NULL,
  provider_reference UUID NOT NULL DEFAULT gen_random_uuid(),
  provider_uuid VARCHAR(128),
  provider VARCHAR(32) NOT NULL DEFAULT 'marzpay' CHECK (provider = 'marzpay'),
  direction VARCHAR(16) NOT NULL DEFAULT 'collection' CHECK (direction IN ('collection', 'disbursement')),
  payment_method VARCHAR(24) NOT NULL DEFAULT 'mobile_money' CHECK (payment_method = 'mobile_money'),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency VARCHAR(3) NOT NULL DEFAULT 'UGX' CHECK (currency = 'UGX'),
  settlement_account_id UUID NOT NULL,
  member_account_id UUID NOT NULL,
  transaction_id UUID,
  phone_masked VARCHAR(24),
  status VARCHAR(16) NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'processing', 'settled', 'failed', 'expired', 'review')),
  provider_status VARCHAR(64),
  failure_reason VARCHAR(255),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_by UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at TIMESTAMPTZ,
  CONSTRAINT payment_intents_org_id_fkey FOREIGN KEY (organization_id)
    REFERENCES public.organizations(id) ON DELETE RESTRICT,
  CONSTRAINT payment_intents_org_settlement_account_fkey FOREIGN KEY (organization_id, settlement_account_id)
    REFERENCES public.accounts(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT payment_intents_org_member_account_fkey FOREIGN KEY (organization_id, member_account_id)
    REFERENCES public.member_accounts(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT payment_intents_org_transaction_fkey FOREIGN KEY (organization_id, transaction_id)
    REFERENCES public.transactions(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT payment_intents_org_idempotency_key_key UNIQUE (organization_id, idempotency_key),
  CONSTRAINT payment_intents_provider_reference_key UNIQUE (provider_reference)
);

CREATE UNIQUE INDEX idx_payment_intents_provider_uuid
  ON public.payment_intents (provider_uuid)
  WHERE provider_uuid IS NOT NULL;
CREATE INDEX idx_payment_intents_org_created
  ON public.payment_intents (organization_id, created_at DESC);
CREATE INDEX idx_payment_intents_org_status
  ON public.payment_intents (organization_id, status, created_at DESC);

ALTER TABLE public.payment_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_isolation ON public.payment_intents
  USING (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

CREATE TRIGGER payment_intents_settlement_account_org
  BEFORE INSERT OR UPDATE ON public.payment_intents
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_organization_reference(
    'settlement_account_id', 'public', 'accounts', 'id'
  );
CREATE TRIGGER payment_intents_member_account_org
  BEFORE INSERT OR UPDATE ON public.payment_intents
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_organization_reference(
    'member_account_id', 'public', 'member_accounts', 'id'
  );
CREATE TRIGGER payment_intents_transaction_org
  BEFORE INSERT OR UPDATE ON public.payment_intents
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_organization_reference(
    'transaction_id', 'public', 'transactions', 'id'
  );

CREATE OR REPLACE FUNCTION public.lookup_marzpay_intent(p_reference UUID)
RETURNS TABLE (id UUID, organization_id UUID, provider_uuid VARCHAR)
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT pi.id, pi.organization_id, pi.provider_uuid
    FROM public.payment_intents pi
   WHERE pi.provider_reference = p_reference
   LIMIT 1
$$;

REVOKE ALL ON FUNCTION public.lookup_marzpay_intent(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lookup_marzpay_intent(UUID) TO xhaira_runtime;
GRANT SELECT, INSERT, UPDATE ON public.payment_intents TO xhaira_runtime;
REVOKE DELETE ON public.payment_intents FROM xhaira_runtime;
GRANT EXECUTE ON FUNCTION public.enforce_same_organization_reference() TO xhaira_runtime;

COMMIT;
