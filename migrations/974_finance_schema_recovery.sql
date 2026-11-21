-- Restore only the missing expense/budget schema and tenant-safe financial summary.
-- This does not create, update, or delete financial records.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.organizations') IS NULL
     OR to_regclass('public.accounts') IS NULL
     OR to_regclass('public.ledger') IS NULL
     OR to_regclass('public.users') IS NULL
     OR to_regprocedure('public.current_organization_id()') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xhaira_runtime') THEN
    RAISE EXCEPTION 'Tenant tables, current_organization_id(), or xhaira_runtime are missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'accounts' AND column_name = 'organization_id')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ledger' AND column_name = 'organization_id')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'organization_id') THEN
    RAISE EXCEPTION 'Tenant organization_id columns are missing; refusing to create unscoped finance tables';
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_accounts_id_organization
  ON public.accounts (id, organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_id_organization
  ON public.ledger (id, organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_id_organization
  ON public.users (id, organization_id);

CREATE TABLE IF NOT EXISTS public.budgets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL DEFAULT public.current_organization_id()
    REFERENCES public.organizations(id) ON DELETE RESTRICT,
  name VARCHAR(255) NOT NULL,
  category VARCHAR(100) NOT NULL DEFAULT 'other',
  amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  currency VARCHAR(3) NOT NULL DEFAULT 'UGX',
  period VARCHAR(30) NOT NULL CHECK (period IN ('monthly', 'quarterly', 'yearly', 'custom')),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  alert_threshold NUMERIC(5,2) NOT NULL DEFAULT 80.00
    CHECK (alert_threshold >= 0 AND alert_threshold <= 100),
  is_active BOOLEAN NOT NULL DEFAULT true,
  notes TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT budgets_valid_date_range CHECK (end_date > start_date),
  CONSTRAINT budgets_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT budgets_created_by_same_organization_fkey
    FOREIGN KEY (created_by, organization_id)
    REFERENCES public.users(id, organization_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS public.expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL DEFAULT public.current_organization_id()
    REFERENCES public.organizations(id) ON DELETE RESTRICT,
  account_id UUID NOT NULL,
  amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  currency VARCHAR(3) NOT NULL DEFAULT 'UGX',
  category VARCHAR(100) NOT NULL,
  subcategory VARCHAR(100),
  vendor VARCHAR(255),
  description TEXT NOT NULL,
  expense_date DATE NOT NULL DEFAULT CURRENT_DATE,
  receipt_url TEXT,
  is_recurring BOOLEAN NOT NULL DEFAULT false,
  recurrence_interval VARCHAR(30),
  status VARCHAR(30) NOT NULL DEFAULT 'recorded'
    CHECK (status IN ('recorded', 'pending', 'approved', 'rejected', 'void')),
  budget_id UUID,
  tags TEXT[] NOT NULL DEFAULT '{}',
  notes TEXT,
  ledger_entry_id UUID,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT expenses_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT expenses_account_same_organization_fkey
    FOREIGN KEY (account_id, organization_id)
    REFERENCES public.accounts(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT expenses_budget_same_organization_fkey
    FOREIGN KEY (budget_id, organization_id)
    REFERENCES public.budgets(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT expenses_ledger_same_organization_fkey
    FOREIGN KEY (ledger_entry_id, organization_id)
    REFERENCES public.ledger(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT expenses_created_by_same_organization_fkey
    FOREIGN KEY (created_by, organization_id)
    REFERENCES public.users(id, organization_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_budgets_organization_period
  ON public.budgets (organization_id, start_date DESC, end_date);
CREATE INDEX IF NOT EXISTS idx_budgets_organization_active
  ON public.budgets (organization_id, is_active);
CREATE INDEX IF NOT EXISTS idx_expenses_organization_date
  ON public.expenses (organization_id, expense_date DESC);
CREATE INDEX IF NOT EXISTS idx_expenses_organization_account
  ON public.expenses (organization_id, account_id);
CREATE INDEX IF NOT EXISTS idx_expenses_organization_budget
  ON public.expenses (organization_id, budget_id) WHERE budget_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_expenses_organization_status
  ON public.expenses (organization_id, status);

ALTER TABLE public.budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.budgets FORCE ROW LEVEL SECURITY;
ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expenses FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS budgets_organization_isolation ON public.budgets;
CREATE POLICY budgets_organization_isolation ON public.budgets
  USING (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());
DROP POLICY IF EXISTS expenses_organization_isolation ON public.expenses;
CREATE POLICY expenses_organization_isolation ON public.expenses
  USING (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.budgets TO xhaira_runtime;
GRANT SELECT, INSERT, UPDATE ON public.expenses TO xhaira_runtime;
REVOKE DELETE ON public.expenses FROM xhaira_runtime;

CREATE OR REPLACE VIEW public.v_financial_summary
WITH (security_invoker = true)
AS
SELECT
  COALESCE(SUM(l.amount) FILTER (WHERE l.amount > 0), 0) AS total_income,
  COALESCE(SUM(ABS(l.amount)) FILTER (WHERE l.amount < 0), 0) AS total_expenses,
  COALESCE(SUM(l.amount), 0) AS net_position,
  COUNT(*) FILTER (WHERE l.amount > 0) AS income_transactions,
  COUNT(*) FILTER (WHERE l.amount < 0) AS expense_transactions,
  COUNT(*) AS total_transactions,
  COALESCE(SUM(l.amount) FILTER (WHERE l.amount > 0), 0) AS total_credits,
  COALESCE(SUM(ABS(l.amount)) FILTER (WHERE l.amount < 0), 0) AS total_debits,
  COALESCE(SUM(l.amount), 0) AS net
FROM public.ledger l
WHERE l.organization_id = public.current_organization_id();

GRANT SELECT ON public.v_financial_summary TO xhaira_runtime;

COMMIT;
