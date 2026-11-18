BEGIN;

ALTER TABLE public.payment_intents
  ADD COLUMN provider_fee_minor BIGINT NOT NULL DEFAULT 0
    CHECK (provider_fee_minor >= 0);

INSERT INTO public.sacco_configurations
  (organization_id, config_key, config_value, config_type, category, label, description)
SELECT id, 'payments.marzpay.collection_fee_rule',
       '{"version":1,"basis_points":300,"fee_bearer":"payer"}'::jsonb,
       'json', 'accounts', 'MarzPay collection fee',
       'Configured provider surcharge paid by the payer; recorded separately from the net amount credited to the organization and member.'
  FROM public.organizations
ON CONFLICT (organization_id, config_key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.seed_marzpay_collection_fee_rule()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.sacco_configurations
    (organization_id, config_key, config_value, config_type, category, label, description)
  VALUES (
    NEW.id,
    'payments.marzpay.collection_fee_rule',
    '{"version":1,"basis_points":300,"fee_bearer":"payer"}'::jsonb,
    'json',
    'accounts',
    'MarzPay collection fee',
    'Configured provider surcharge paid by the payer; recorded separately from the net amount credited to the organization and member.'
  )
  ON CONFLICT (organization_id, config_key) DO NOTHING;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.seed_marzpay_collection_fee_rule() FROM PUBLIC;

CREATE TRIGGER organizations_seed_marzpay_collection_fee
  AFTER INSERT ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.seed_marzpay_collection_fee_rule();

COMMIT;
