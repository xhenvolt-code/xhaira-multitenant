import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/permissions.js';
import { getPool } from '@/lib/db.js';
import { createMobileMoneyCollection } from '@/lib/payment-collection-service.js';
import { isMarzpayConfigured } from '@/lib/payments/marzpay.js';
import { getMarzpaySettlementAccount } from '@/lib/payments/settlement-account.js';
import { runWithOrganizationContext } from '@/lib/organization-context.js';

export const runtime = 'nodejs';

function callbackUrl() {
  const configured = process.env.NEXT_PUBLIC_APP_URL || process.env.API_URL;
  if (!configured) return null;
  try {
    const url = new URL(configured);
    return url.protocol === 'https:' ? `${url.origin}/api/webhooks/marzpay` : null;
  } catch {
    return null;
  }
}

export async function GET(request) {
  const permission = await requirePermission(request, 'payments.view');
  if (permission instanceof NextResponse) return permission;
  const { searchParams } = new URL(request.url);
  const requestedLimit = Number(searchParams.get('limit') || 50);
  const limit = Math.min(Math.max(Number.isInteger(requestedLimit) ? requestedLimit : 50, 1), 100);
  return runWithOrganizationContext(permission.auth.organizationId, async () => {
    const settlementAccount = await getMarzpaySettlementAccount();
    const result = await getPool().query(
        `SELECT id, direction, amount_minor, provider_amount_minor, provider_fee_minor, ledger_amount_minor,
              metadata->>'reason' AS reason, metadata->>'depositor_name' AS depositor_name,
              metadata->>'receiver_name' AS receiver_name,
              provider_currency, provider_mode, currency, payment_method, status, provider_status,
              ledger_status, reconciliation_status, reconciliation_error,
              reconciliation_adjustment_transaction_id, ledger_failure_reason,
              failure_reason, phone_masked, transaction_id, created_at, settled_at
         FROM payment_intents
        WHERE direction = 'collection'
        ORDER BY created_at DESC
        LIMIT $1`,
      [limit]
    );
    return NextResponse.json({
      success: true,
      configured: isMarzpayConfigured(),
      enabled: isMarzpayConfigured(),
      settlementAccount,
      data: result.rows,
    });
  });
}

export async function POST(request) {
  const permission = await requirePermission(request, 'payments.create');
  if (permission instanceof NextResponse) return permission;
  const body = await request.json().catch(() => null);
  return runWithOrganizationContext(permission.auth.organizationId, async () => {
    const result = await createMobileMoneyCollection({
      amountUgx: Number(body?.amountUgx),
      phone: typeof body?.phone === 'string' ? body.phone : '',
      memberAccountId: body?.memberAccountId,
      depositorName: typeof body?.depositorName === 'string' ? body.depositorName.trim() : '',
      receiverName: typeof body?.receiverName === 'string' ? body.receiverName.trim() : '',
      reason: typeof body?.reason === 'string' ? body.reason.trim() : '',
      idempotencyKey: request.headers.get('idempotency-key'),
      userId: permission.auth.userId,
      callbackUrl: callbackUrl(),
    });
    if (!result.ok) return NextResponse.json({ success: false, error: result.error, id: result.id, status: result.state }, { status: result.status });
    const intent = result.id
      ? (await getPool().query(
        `SELECT status, provider_status, provider_amount_minor, provider_fee_minor, ledger_amount_minor,
                metadata->>'reason' AS reason, metadata->>'depositor_name' AS depositor_name,
                metadata->>'receiver_name' AS receiver_name,
                provider_currency, ledger_status, reconciliation_status, reconciliation_error,
                reconciliation_adjustment_transaction_id, ledger_failure_reason, failure_reason
           FROM payment_intents WHERE id = $1`,
        [result.id]
      )).rows[0]
      : null;
    return NextResponse.json({
      success: true,
      id: result.id,
      status: intent?.status || result.status,
      provider_status: intent?.provider_status,
      provider_amount_minor: intent?.provider_amount_minor,
      provider_fee_minor: intent?.provider_fee_minor,
      reason: intent?.reason,
      depositor_name: intent?.depositor_name,
      receiver_name: intent?.receiver_name,
      ledger_amount_minor: intent?.ledger_amount_minor,
      provider_currency: intent?.provider_currency,
      ledger_status: intent?.ledger_status,
      reconciliation_status: intent?.reconciliation_status,
      reconciliation_error: intent?.reconciliation_error,
      reconciliation_adjustment_transaction_id: intent?.reconciliation_adjustment_transaction_id,
      ledger_failure_reason: intent?.ledger_failure_reason,
      failure_reason: intent?.failure_reason || result.error,
      amountUgx: result.amountUgx,
      duplicate: result.duplicate || false,
    }, { status: result.duplicate ? 200 : 202 });
  });
}
