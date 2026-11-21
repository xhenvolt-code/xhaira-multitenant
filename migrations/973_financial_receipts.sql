-- Stable printable receipt identifiers for financial transaction records.
-- Historical records keep their ledger data unchanged; the receipt endpoint
-- derives a stable identifier from their existing transaction/source UUID.

BEGIN;

ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS receipt_number TEXT;
ALTER TABLE public.ledger ADD COLUMN IF NOT EXISTS receipt_number TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_transactions_organization_receipt_number
  ON public.transactions (organization_id, receipt_number)
  WHERE receipt_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ledger_organization_receipt_number
  ON public.ledger (organization_id, receipt_number)
  WHERE receipt_number IS NOT NULL;

CREATE OR REPLACE FUNCTION public.assign_transaction_receipt_number()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS NULL THEN NEW.id := gen_random_uuid(); END IF;
  IF NULLIF(BTRIM(NEW.receipt_number), '') IS NULL THEN
    NEW.receipt_number := 'RCP-' || UPPER(REPLACE(NEW.id::TEXT, '-', ''));
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.assign_ledger_receipt_number()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE receipt_source UUID;
BEGIN
  IF NEW.id IS NULL THEN NEW.id := gen_random_uuid(); END IF;
  receipt_source := COALESCE(NEW.source_id, NEW.id);
  IF NULLIF(BTRIM(NEW.receipt_number), '') IS NULL THEN
    NEW.receipt_number := 'RCP-' || UPPER(REPLACE(receipt_source::TEXT, '-', ''));
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_assign_transaction_receipt_number ON public.transactions;
CREATE TRIGGER trg_assign_transaction_receipt_number
  BEFORE INSERT ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.assign_transaction_receipt_number();

DROP TRIGGER IF EXISTS trg_assign_ledger_receipt_number ON public.ledger;
CREATE TRIGGER trg_assign_ledger_receipt_number
  BEFORE INSERT ON public.ledger
  FOR EACH ROW EXECUTE FUNCTION public.assign_ledger_receipt_number();

COMMIT;
