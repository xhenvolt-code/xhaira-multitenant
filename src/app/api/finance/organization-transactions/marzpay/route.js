import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/permissions.js';
import { getPool } from '@/lib/db.js';
import { createMobileMoneyCollection, syncMobileMoneyIntent } from '@/lib/payment-collection-service.js';
import { getMarzpaySettlementAccount } from '@/lib/payments/settlement-account.js';
import { isMarzpayConfigured } from '@/lib/payments/marzpay.js';
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
  const permission = await requirePermission(request, 'finance.view');
  if (permission instanceof NextResponse) return permission;
  const organizationId = permission.auth.organizationId;
  if (!organizationId) return NextResponse.json({ success: false, error: 'Organization context required' }, { status: 400 });

  return runWithOrganizationContext(organizationId, async () => {
    const { searchParams } = new URL(request.url);
    const intentId = searchParams.get('intent_id');
    if (intentId) {
      const visible = await getPool().query(
        `SELECT id FROM payment_intents
          WHERE id = $1 AND organization_id = $2 AND organization_account_id IS NOT NULL`,
        [intentId, organizationId]
      );
      if (!visible.rows[0]) return NextResponse.json({ success: false, error: 'Collection not found' }, { status: 404 });
      const sync = await syncMobileMoneyIntent(intentId);
      const result = await getPool().query(
        `SELECT id, direction, amount_minor, provider_amount_minor, provider_fee_minor, ledger_amount_minor,
                status, provider_status, failure_reason, phone_masked, transaction_id, created_at, settled_at,
                metadata->>'reason' AS reason, metadata->>'depositor_name' AS depositor_name
           FROM payment_intents
          WHERE id = $1 AND organization_id = $2 AND organization_account_id IS NOT NULL`,
        [intentId, organizationId]
      );
      return NextResponse.json({ success: true, data: result.rows[0], reconciliationError: sync.error });
    }

    const settlementAccount = await getMarzpaySettlementAccount(organizationId);
    return NextResponse.json({
      success: true,
      configured: isMarzpayConfigured(),
      settlementAccount,
    });
  });
}

export async function POST(request) {
  const permission = await requirePermission(request, 'payments.create');
  if (permission instanceof NextResponse) return permission;
  const organizationId = permission.auth.organizationId;
  if (!organizationId) return NextResponse.json({ success: false, error: 'Organization context required' }, { status: 400 });
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return NextResponse.json({ success: false, error: 'A valid JSON body is required' }, { status: 400 });

  return runWithOrganizationContext(organizationId, async () => {
    const settlementAccount = await getMarzpaySettlementAccount(organizationId);
    if (!settlementAccount) return NextResponse.json({ success: false, error: 'Configure an active UGX MarzPay settlement account in settings first' }, { status: 409 });
    const result = await createMobileMoneyCollection({
      amountUgx: Number(body.amountUgx),
      phone: typeof body.phone === 'string' ? body.phone : '',
      organizationAccountId: settlementAccount.id,
      depositorName: typeof body.depositorName === 'string' ? body.depositorName.trim() : '',
      reason: typeof body.reason === 'string' ? body.reason.trim() : '',
      idempotencyKey: request.headers.get('idempotency-key'),
      userId: permission.auth.userId,
      callbackUrl: callbackUrl(),
    });
    if (!result.ok) return NextResponse.json({ success: false, error: result.error, id: result.id, status: result.state }, { status: result.status });

    const intent = result.id
      ? (await getPool().query(
        `SELECT id, status, provider_status, amount_minor, provider_amount_minor, provider_fee_minor,
                ledger_amount_minor, failure_reason, phone_masked, created_at, settled_at,
                metadata->>'reason' AS reason, metadata->>'depositor_name' AS depositor_name
           FROM payment_intents
          WHERE id = $1 AND organization_id = $2 AND organization_account_id IS NOT NULL`,
        [result.id, organizationId]
      )).rows[0]
      : null;
    return NextResponse.json({ success: true, id: result.id, status: intent?.status || result.status, data: intent,
      amountUgx: result.amountUgx, duplicate: result.duplicate || false }, { status: result.duplicate ? 200 : 202 });
  });
}
