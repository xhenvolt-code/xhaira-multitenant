-- Organization-scoped loan policy defaults, external guarantors, and term units.
-- Apply in a maintenance window: index creation and ALTER TABLE may take locks.
-- No loan balances, ledger rows, or payment records are changed.
-- Forward recovery: this migration is transactional and idempotent; if it fails,
-- resolve the reported constraint/data conflict and rerun the complete file.

BEGIN;

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS duration_unit TEXT NOT NULL DEFAULT 'MONTHS';

ALTER TABLE public.loans
  ADD COLUMN IF NOT EXISTS duration_unit TEXT NOT NULL DEFAULT 'MONTHS';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.products'::regclass
       AND conname = 'products_duration_unit_check'
  ) THEN
    ALTER TABLE public.products
      ADD CONSTRAINT products_duration_unit_check
      CHECK (duration_unit IN ('DAYS', 'WEEKS', 'MONTHS', 'YEARS'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.loans'::regclass
       AND conname = 'loans_duration_unit_check'
  ) THEN
    ALTER TABLE public.loans
      ADD CONSTRAINT loans_duration_unit_check
      CHECK (duration_unit IN ('DAYS', 'WEEKS', 'MONTHS', 'YEARS'));
  END IF;
END;
$$;

-- Replace the historical global rule key with a tenant-aware key.
DO $$
DECLARE
  item RECORD;
BEGIN
  FOR item IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'public.sacco_rules'::regclass
       AND contype = 'u'
       AND conkey = ARRAY[
         (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.sacco_rules'::regclass AND attname = 'rule_type'),
         (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.sacco_rules'::regclass AND attname = 'rule_key')
       ]::smallint[]
  LOOP
    EXECUTE format('ALTER TABLE public.sacco_rules DROP CONSTRAINT %I', item.conname);
  END LOOP;

  FOR item IN
    SELECT idx.relname AS index_name
      FROM pg_index i
      JOIN pg_class tbl ON tbl.oid = i.indrelid
      JOIN pg_class idx ON idx.oid = i.indexrelid
     WHERE tbl.oid = 'public.sacco_rules'::regclass
       AND i.indisunique
       AND NOT i.indisprimary
       AND i.indnkeyatts = 2
       AND i.indkey[0] = (
         SELECT attnum FROM pg_attribute
          WHERE attrelid = 'public.sacco_rules'::regclass AND attname = 'rule_type'
       )
       AND i.indkey[1] = (
         SELECT attnum FROM pg_attribute
          WHERE attrelid = 'public.sacco_rules'::regclass AND attname = 'rule_key'
       )
  LOOP
    EXECUTE format('DROP INDEX public.%I', item.index_name);
  END LOOP;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_sacco_rules_organization_type_key
  ON public.sacco_rules (organization_id, rule_type, rule_key);

CREATE TABLE IF NOT EXISTS public.loan_external_guarantors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL DEFAULT public.current_organization_id()
    REFERENCES public.organizations(id) ON DELETE RESTRICT,
  loan_id UUID NOT NULL REFERENCES public.loans(id) ON DELETE CASCADE,
  full_name VARCHAR(255),
  phone VARCHAR(50),
  national_id VARCHAR(100),
  physical_address TEXT,
  occupation VARCHAR(255),
  relationship VARCHAR(100),
  guaranteed_amount NUMERIC(18, 2) NOT NULL CHECK (guaranteed_amount > 0),
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT loan_external_guarantors_status_check
    CHECK (status IN ('PENDING', 'ACCEPTED', 'DECLINED', 'RELEASED'))
);

CREATE INDEX IF NOT EXISTS idx_loan_external_guarantors_loan
  ON public.loan_external_guarantors (organization_id, loan_id);

DROP TRIGGER IF EXISTS org_ref_loan_external_guarantors_loan_id_fkey
  ON public.loan_external_guarantors;
CREATE TRIGGER org_ref_loan_external_guarantors_loan_id_fkey
  BEFORE INSERT OR UPDATE ON public.loan_external_guarantors
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_same_organization_reference('loan_id', 'public', 'loans', 'id');

ALTER TABLE public.loan_external_guarantors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loan_external_guarantors FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS organization_isolation ON public.loan_external_guarantors;
CREATE POLICY organization_isolation ON public.loan_external_guarantors
  USING (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.loan_external_guarantors TO xhaira_runtime;

-- A withdrawal restriction defaults to off to preserve current account behavior.
INSERT INTO public.account_type_rules
  (organization_id, account_type_id, rule_key, rule_value, description, is_enabled)
SELECT at.organization_id, at.id, 'block_withdrawal_if_active_loan', 'false'::jsonb,
       'When enabled, members with a pending, approved, disbursed, or active loan cannot withdraw from this account type.',
       TRUE
  FROM public.account_types at
ON CONFLICT (account_type_id, rule_key) DO NOTHING;

-- Add explicit, editable defaults for existing organizations. Existing member
-- guarantor counts are retained while one outside guarantor and its fields are
-- required by default.
INSERT INTO public.sacco_rules (organization_id, rule_type, rule_key, rule_value, description)
SELECT o.id, seed.rule_type, seed.rule_key, seed.rule_value::jsonb, seed.description
  FROM public.organizations o
 CROSS JOIN (VALUES
   ('LOAN', 'min_fixed_savings_for_loan', '{"amount":500000}', 'Minimum fixed savings balance required to qualify for a loan'),
   ('LOAN', 'max_loan_multiplier', '{"multiplier":3}', 'Maximum loan amount as a multiple of eligible fixed savings'),
   ('LOAN', 'max_active_loans', '{"count":2}', 'Maximum pending, approved, or active loans per member'),
   ('LOAN', 'default_interest_rate', '{"rate_percent":10}', 'Default annual simple-interest rate used when a loan product has no rate or is not selected'),
   ('LOAN', 'default_duration', '{"value":12,"unit":"MONTHS"}', 'Default loan term when no loan product is selected'),
   ('LOAN', 'default_repayment_cycle', '{"cycle":"MONTHLY"}', 'Default repayment cycle when no loan product is selected'),
   ('GUARANTOR', 'max_guarantee_percentage', '{"percentage":50}', 'Maximum percentage of savings a member may guarantee'),
   ('GUARANTOR', 'min_membership_months', '{"months":3}', 'Minimum membership period before a member can guarantee a loan')
 ) AS seed(rule_type, rule_key, rule_value, description)
 WHERE NOT EXISTS (
   SELECT 1 FROM public.sacco_rules existing
    WHERE existing.organization_id = o.id
      AND existing.rule_type = seed.rule_type
      AND existing.rule_key = seed.rule_key
 );

UPDATE public.sacco_rules
   SET rule_value =
       rule_value ||
       jsonb_build_object(
         'count',
         CASE
           WHEN COALESCE(rule_value->>'member_count', rule_value->>'count') ~ '^[0-9]+$'
             THEN COALESCE(rule_value->>'member_count', rule_value->>'count')::integer
           ELSE 2
         END,
         'member_count',
         CASE
           WHEN COALESCE(rule_value->>'member_count', rule_value->>'count') ~ '^[0-9]+$'
             THEN COALESCE(rule_value->>'member_count', rule_value->>'count')::integer
           ELSE 2
         END,
         'external_count',
         CASE
           WHEN rule_value->>'external_count' ~ '^[0-9]+$' THEN (rule_value->>'external_count')::integer
           ELSE 1
         END,
         'member_scope',
         CASE
           WHEN rule_value->>'member_scope' IN ('SAME_GROUP', 'ANY_ORGANIZATION_MEMBER')
             THEN rule_value->>'member_scope'
           ELSE 'SAME_GROUP'
         END,
         'external_required_fields',
         COALESCE(
           rule_value->'external_required_fields',
           '["full_name","phone","national_id","physical_address","occupation","relationship"]'::jsonb
         )
       ),
       updated_at = NOW()
 WHERE rule_type = 'LOAN'
   AND rule_key = 'guarantors_required';

INSERT INTO public.sacco_rules (organization_id, rule_type, rule_key, rule_value, description)
SELECT o.id, 'LOAN', 'guarantors_required',
       '{"count":2,"member_count":2,"external_count":1,"member_scope":"SAME_GROUP","external_required_fields":["full_name","phone","national_id","physical_address","occupation","relationship"]}'::jsonb,
       'Required active member and outside guarantors; external fields are configurable'
  FROM public.organizations o
 WHERE NOT EXISTS (
   SELECT 1 FROM public.sacco_rules r
    WHERE r.organization_id = o.id
      AND r.rule_type = 'LOAN'
      AND r.rule_key = 'guarantors_required'
 );

-- New organizations receive their own copies of editable loan policy defaults.
CREATE OR REPLACE FUNCTION public.seed_organization_loan_rules()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM set_config('app.organization_id', NEW.id::text, true);
  INSERT INTO public.sacco_rules (organization_id, rule_type, rule_key, rule_value, description)
  VALUES
    (NEW.id, 'LOAN', 'min_fixed_savings_for_loan', '{"amount":500000}', 'Minimum fixed savings balance required to qualify for a loan'),
    (NEW.id, 'LOAN', 'max_loan_multiplier', '{"multiplier":3}', 'Maximum loan amount as a multiple of eligible fixed savings'),
    (NEW.id, 'LOAN', 'max_active_loans', '{"count":2}', 'Maximum pending, approved, or active loans per member'),
    (NEW.id, 'LOAN', 'default_interest_rate', '{"rate_percent":10}', 'Default annual simple-interest rate used when a loan product has no rate or is not selected'),
    (NEW.id, 'LOAN', 'default_duration', '{"value":12,"unit":"MONTHS"}', 'Default loan term when no loan product is selected'),
    (NEW.id, 'LOAN', 'default_repayment_cycle', '{"cycle":"MONTHLY"}', 'Default repayment cycle when no loan product is selected'),
    (NEW.id, 'LOAN', 'guarantors_required', '{"count":2,"member_count":2,"external_count":1,"member_scope":"SAME_GROUP","external_required_fields":["full_name","phone","national_id","physical_address","occupation","relationship"]}', 'Required active member and outside guarantors; requirements are configurable'),
    (NEW.id, 'GUARANTOR', 'max_guarantee_percentage', '{"percentage":50}', 'Maximum percentage of savings a member may guarantee'),
    (NEW.id, 'GUARANTOR', 'min_membership_months', '{"months":3}', 'Minimum membership period before a member can guarantee a loan')
  ON CONFLICT (organization_id, rule_type, rule_key) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_seed_organization_loan_rules ON public.organizations;
CREATE TRIGGER trg_seed_organization_loan_rules
  AFTER INSERT ON public.organizations
  FOR EACH ROW
  EXECUTE FUNCTION public.seed_organization_loan_rules();

COMMIT;
