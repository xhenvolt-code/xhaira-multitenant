import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/permissions.js';
import { getPool } from '@/lib/db.js';
import { syncMobileMoneyIntent } from '@/lib/payment-collection-service.js';
import { runWithOrganizationContext } from '@/lib/organization-context.js';

export const runtime = 'nodejs';

export async function GET(request, { params }) {
  const permission = await requirePermission(request, 'finance.view');
  if (permission instanceof NextResponse) return permission;
  const { id } = await params;
  const intentId = String(id || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(intentId)) {
    return NextResponse.json({ success: false, error: 'Transaction not found' }, { status: 404 });
  }
  return runWithOrganizationContext(permission.auth.organizationId, async () => {
    const pool = getPool();
    const visible = await pool.query('SELECT id FROM payment_intents WHERE id = $1', [intentId]);
    if (!visible.rows[0]) return NextResponse.json({ success: false, error: 'Transaction not found' }, { status: 404 });

    const sync = await syncMobileMoneyIntent(intentId);
    const result = await pool.query(
      `      SELECT id, direction, amount_minor, provider_amount_minor, provider_fee_minor, provider_fee_confirmed, ledger_amount_minor,
              provider_currency, provider_mode, currency, payment_method, status, provider_status,
              ledger_status, reconciliation_status, reconciliation_error,
              reconciliation_adjustment_transaction_id, ledger_failure_reason,
              failure_reason, phone_masked, transaction_id, created_at, settled_at
         FROM payment_intents WHERE id = $1`,
      [intentId]
    );
    return NextResponse.json({ success: true, data: result.rows[0], reconciliationError: sync.error });
  });
}
