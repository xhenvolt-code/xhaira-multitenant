import { getPool } from '@/lib/db.js';

export const MARZPAY_SETTLEMENT_ACCOUNT_KEY = 'payments.marzpay.settlement_account_id';
export const MARZPAY_COLLECTION_FEE_KEY = 'payments.marzpay.collection_fee_rule';

export async function getMarzpaySettlementAccount() {
  const result = await getPool().query(
    `SELECT a.id, a.name, a.type, a.currency
       FROM sacco_configurations c
       JOIN accounts a ON a.id::text = c.config_value #>> '{}'
      WHERE c.organization_id = public.current_organization_id()
        AND a.organization_id = public.current_organization_id()
        AND c.config_key = $1
        AND a.type = 'mobile_money'
        AND a.currency = 'UGX'
        AND a.is_active = true
        AND a.status = 'active'
      LIMIT 1`,
    [MARZPAY_SETTLEMENT_ACCOUNT_KEY]
  );
  return result.rows[0] || null;
}

export async function getMarzpayCollectionFeeBasisPoints() {
  const result = await getPool().query(
    `SELECT config_value
       FROM sacco_configurations
      WHERE organization_id = public.current_organization_id()
        AND config_key = $1
      LIMIT 1`,
    [MARZPAY_COLLECTION_FEE_KEY]
  );
  const rule = result.rows[0]?.config_value;
  if (!rule || rule.version !== 1 || rule.fee_bearer !== 'payer' ||
      !Number.isInteger(rule.basis_points) || rule.basis_points < 0 || rule.basis_points > 10000) {
    return null;
  }
  return rule.basis_points;
}
