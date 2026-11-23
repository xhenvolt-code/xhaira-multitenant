import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/permissions.js';
import { getPool } from '@/lib/db.js';
import { runWithOrganizationContext } from '@/lib/organization-context.js';
import { syncMobileMoneyIntent } from '@/lib/payment-collection-service.js';

export const runtime = 'nodejs';

export async function GET(request, { params }) {
  const permission = await requirePermission(request, 'finance.view');
  if (permission instanceof NextResponse) return permission;
  const { id } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(id || ''))) {
    return NextResponse.json({ success: false, error: 'Organization mobile-money transaction not found' }, { status: 404 });
  }
  return runWithOrganizationContext(permission.auth.organizationId, async () => {
    const visible = await getPool().query(
      `SELECT id FROM payment_intents
        WHERE id = $1 AND organization_account_id IS NOT NULL
          AND metadata->>'transaction_scope' = 'organization'`,
      [id]
    );
    if (!visible.rows[0]) {
      return NextResponse.json({ success: false, error: 'Organization mobile-money transaction not found' }, { status: 404 });
    }

    const sync = await syncMobileMoneyIntent(id);
    const result = await getPool().query(
      `SELECT id, direction, status, provider_status, amount_minor,
              provider_amount_minor, provider_fee_minor, ledger_amount_minor,
              ledger_status, reconciliation_status, reconciliation_error,
              failure_reason, ledger_failure_reason, transaction_id, created_at, settled_at,
              metadata->>'reason' AS reason,
              metadata->>'payment_method' AS payment_method
         FROM payment_intents WHERE id = $1`,
      [id]
    );
    return NextResponse.json({ success: true, data: result.rows[0], sync_error: sync.error || null });
  });
}
