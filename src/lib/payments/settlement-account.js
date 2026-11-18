import { getPool } from '@/lib/db.js';

export const MARZPAY_SETTLEMENT_ACCOUNT_KEY = 'payments.marzpay.settlement_account_id';

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
