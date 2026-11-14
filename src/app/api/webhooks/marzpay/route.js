import { NextResponse } from 'next/server';
import { query } from '@/lib/db.js';
import { runWithOrganizationContext } from '@/lib/organization-context.js';
import { getMarzpayConfig, normalizeMarzpayTransaction, verifyMarzpayWebhook } from '@/lib/payments/marzpay.js';
import { syncMobileMoneyIntent } from '@/lib/payment-collection-service.js';

export const runtime = 'nodejs';

export async function POST(request) {
  const config = getMarzpayConfig();
  if (!config) return NextResponse.json({ success: false, error: 'Provider is not configured' }, { status: 503 });
  const rawBody = await request.text();
  if (config.webhookSecret) {
    const signature = verifyMarzpayWebhook(rawBody, request.headers.get('x-marzpay-signature'), config.webhookSecret);
    if (signature === 'invalid') return NextResponse.json({ success: false, error: 'Invalid signature' }, { status: 401 });
  }

  let payload;
  try { payload = JSON.parse(rawBody); }
  catch { return NextResponse.json({ success: true, ignored: true }); }
  const transaction = normalizeMarzpayTransaction(payload);
  const reference = transaction.reference;
  if (!reference || !/^[0-9a-f-]{36}$/i.test(reference)) return NextResponse.json({ success: true, ignored: true });

  const lookup = await query('SELECT * FROM public.lookup_marzpay_intent($1)', [reference]);
  const intent = lookup.rows[0];
  if (!intent) return NextResponse.json({ success: true, ignored: true });

  const result = await runWithOrganizationContext(intent.organization_id, () => syncMobileMoneyIntent(intent.id, transaction.uuid));
  return NextResponse.json({ success: true, status: result.status });
}
