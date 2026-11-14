BEGIN;

-- Support tenant-scoped budget utilization and loan listing queries.
CREATE INDEX IF NOT EXISTS idx_expenses_org_budget_date
  ON public.expenses (organization_id, budget_id, expense_date);

CREATE INDEX IF NOT EXISTS idx_loans_org_created_at
  ON public.loans (organization_id, created_at DESC);

COMMIT;
