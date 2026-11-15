import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/permissions.js';
import { getPool } from '@/lib/db.js';
import { isMarzpayConfigured } from '@/lib/payments/marzpay.js';
import { createMobileMoneyCollection } from '@/lib/payment-collection-service.js';
import { createMobileMoneyDisbursement } from '@/lib/payment-disbursement-service.js';
import { isDatabaseConnectionError } from '@/lib/db.js';
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
  const accounts = await getPool().query(
    `SELECT id, name, type, currency, is_active
       FROM accounts
      WHERE type = 'mobile_money' AND currency = 'UGX' AND is_active = true
      ORDER BY name`
  );
  return NextResponse.json({
    success: true,
    configured: isMarzpayConfigured(),
    collectionsEnabled: isMarzpayConfigured(),
    disbursementsEnabled: isMarzpayConfigured(),
    accounts: accounts.rows,
  });
}

export async function POST(request) {
  let permission;
  try {
    permission = await requirePermission(request, 'finance.manage');
  } catch (error) {
    console.error('[MarzPay] Authentication/database error:', error.message);
    return NextResponse.json({ success: false, error: isDatabaseConnectionError(error)
      ? 'Database temporarily unavailable. No payment was started; please retry shortly.'
      : 'Could not authorize this payment request.' }, { status: isDatabaseConnectionError(error) ? 503 : 500 });
  }
  if (permission instanceof NextResponse) return permission;
  const body = await request.json().catch(() => null);
  const action = body?.action;
  if (!['deposit', 'withdraw'].includes(action)) {
    return NextResponse.json({ success: false, error: 'action must be deposit or withdraw' }, { status: 400 });
  }

  const input = {
    amountUgx: Number(body?.amountUgx),
    phone: typeof body?.phone === 'string' ? body.phone : '',
    settlementAccountId: body?.settlementAccountId,
    memberAccountId: body?.memberAccountId,
    idempotencyKey: request.headers.get('idempotency-key'),
    userId: permission.auth.userId,
    callbackUrl: callbackUrl(),
  };
  try {
  const { result, intentDetails } = await runWithOrganizationContext(permission.auth.organizationId, async () => {
    const result = action === 'deposit'
      ? await createMobileMoneyCollection(input)
      : await createMobileMoneyDisbursement(input);
    const intentDetails = result.id
      ? (await getPool().query('SELECT status, provider_status, failure_reason FROM payment_intents WHERE id = $1', [result.id])).rows[0]
      : null;
    return { result, intentDetails };
  });

  // A transport timeout can leave the provider outcome unknown. Keep the
  // intent visible so the UI polls and reconciles instead of asking for retry.
  if (!result.ok && result.status === 202 && result.id) {
    return NextResponse.json({ success: true, id: result.id, status: intentDetails?.status || result.state, provider_status: intentDetails?.provider_status, failure_reason: result.error || intentDetails?.failure_reason, amountUgx: input.amountUgx, pendingReview: true }, { status: 202 });
  }
  if (!result.ok) {
    return NextResponse.json(
      { success: false, error: result.error, id: result.id, status: result.state },
      { status: result.status }
    );
  }
  return NextResponse.json(
    { success: true, id: result.id, status: intentDetails?.status || result.status, provider_status: intentDetails?.provider_status, failure_reason: result.failureReason || intentDetails?.failure_reason, amountUgx: result.amountUgx, duplicate: result.duplicate || false },
    { status: result.duplicate ? 200 : 202 }
  );
  } catch (error) {
    console.error(`[MarzPay] ${action} request failed:`, error.message);
    const status = isDatabaseConnectionError(error) ? 503 : 502;
    return NextResponse.json({ success: false,
      error: isDatabaseConnectionError(error)
        ? 'Database connection failed while preparing this payment. Check transaction status before retrying.'
        : `MarzPay ${action} failed: ${error.message || 'Unexpected provider or reconciliation error'}`,
      outcome: 'unknown' }, { status });
  }
}
