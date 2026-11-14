import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/permissions.js';
import { getPool } from '@/lib/db.js';
import { createMobileMoneyCollection } from '@/lib/payment-collection-service.js';
import { isMarzpayConfigured } from '@/lib/payments/marzpay.js';

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
  const result = await getPool().query(
    `SELECT id, amount_minor, currency, payment_method, status, provider_status,
            failure_reason, phone_masked, transaction_id, created_at, settled_at
       FROM payment_intents
      ORDER BY created_at DESC
      LIMIT $1`,
    [limit]
  );
  return NextResponse.json({
    success: true,
    configured: isMarzpayConfigured(),
    enabled: isMarzpayConfigured() && process.env.MARZPAY_COLLECTIONS_ENABLED === 'true',
    data: result.rows,
  });
}

export async function POST(request) {
  const permission = await requirePermission(request, 'payments.create');
  if (permission instanceof NextResponse) return permission;
  const body = await request.json().catch(() => null);
  const result = await createMobileMoneyCollection({
    amountUgx: Number(body?.amountUgx),
    phone: typeof body?.phone === 'string' ? body.phone : '',
    settlementAccountId: body?.settlementAccountId,
    memberAccountId: body?.memberAccountId,
    idempotencyKey: request.headers.get('idempotency-key'),
    userId: permission.auth.userId,
    callbackUrl: callbackUrl(),
  });
  if (!result.ok) return NextResponse.json({ success: false, error: result.error, id: result.id, status: result.state }, { status: result.status });
  return NextResponse.json({ success: true, id: result.id, status: result.status, amountUgx: result.amountUgx, duplicate: result.duplicate || false }, { status: result.duplicate ? 200 : 202 });
}