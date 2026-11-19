import { getPool } from '@/lib/db.js';
import { getOrganizationContext } from '@/lib/organization-context.js';

export const MARZPAY_SETTLEMENT_ACCOUNT_KEY = 'payments.marzpay.settlement_account_id';
export const MARZPAY_RECONCILIATION_ACCOUNT_KEY = 'payments.marzpay.reconciliation_account_id';
export const MARZPAY_COLLECTION_FEE_KEY = 'payments.marzpay.collection_fee_rule';

async function queryWithOrganizationContext(organizationId, operation) {
  if (typeof organizationId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(organizationId)) {
    throw new TypeError('A valid organization ID is required to load MarzPay settings');
  }

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE xhaira_runtime');
    await client.query("SELECT set_config('app.organization_id', $1, true)", [organizationId]);
    const result = await operation(client, organizationId);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.release();
  }
}

export async function getMarzpaySettlementAccount(organizationId = getOrganizationContext()) {
  const result = await queryWithOrganizationContext(
    organizationId,
    (client, tenantId) => client.query(
      `SELECT a.id, a.name, a.type, a.currency
         FROM sacco_configurations c
         JOIN accounts a ON a.id::text = c.config_value #>> '{}'
        WHERE c.organization_id = $1
          AND a.organization_id = $1
          AND c.config_key = $2
          AND a.type = 'mobile_money'
          AND a.currency = 'UGX'
          AND a.is_active = true
          AND a.status = 'active'
        LIMIT 1`,
      [tenantId, MARZPAY_SETTLEMENT_ACCOUNT_KEY]
    )
  );
  return result.rows[0] || null;
}

export async function getMarzpayReconciliationAccount(organizationId = getOrganizationContext()) {
  const result = await queryWithOrganizationContext(
    organizationId,
    (client, tenantId) => client.query(
      `SELECT a.id, a.name, a.type, a.currency
         FROM sacco_configurations c
         JOIN accounts a ON a.id::text = c.config_value #>> '{}'
        WHERE c.organization_id = $1
          AND a.organization_id = $1
          AND c.config_key = $2
          AND a.type = 'system'
          AND a.currency = 'UGX'
          AND a.is_active = true
          AND a.status = 'active'
        LIMIT 1`,
      [tenantId, MARZPAY_RECONCILIATION_ACCOUNT_KEY]
    )
  );
  return result.rows[0] || null;
}

export async function getMarzpayCollectionFeeBasisPoints() {
  const result = await queryWithOrganizationContext(getOrganizationContext(), (client, tenantId) => client.query(
    `SELECT config_value
       FROM sacco_configurations
      WHERE organization_id = $1
        AND config_key = $2
      LIMIT 1`,
    [tenantId, MARZPAY_COLLECTION_FEE_KEY]
  ));
  const rule = result.rows[0]?.config_value;
  if (!rule || rule.version !== 1 || rule.fee_bearer !== 'payer' ||
      !Number.isInteger(rule.basis_points) || rule.basis_points < 0 || rule.basis_points > 10000) {
    return null;
  }
  return rule.basis_points;
}
