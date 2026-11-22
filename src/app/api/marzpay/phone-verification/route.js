import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/permissions.js';
import { isMarzpayConfigured, verifyMarzpayPhone } from '@/lib/payments/marzpay.js';

export const runtime = 'nodejs';

export async function POST(request) {
  let permission = null;
  let denied = null;
  for (const requiredPermission of ['members.create', 'members.manage', 'payments.create']) {
    const access = await requirePermission(request, requiredPermission);
    if (!(access instanceof NextResponse)) {
      permission = access;
      break;
    }
    denied = access;
  }
  if (!permission) return denied;

  if (!isMarzpayConfigured()) {
    return NextResponse.json({ success: false, error: 'MarzPay phone verification is not configured' }, { status: 503 });
  }
  const body = await request.json().catch(() => null);
  if (!body || typeof body.phone !== 'string' || body.phone.length > 32) {
    return NextResponse.json({ success: false, error: 'A valid Uganda phone number is required' }, { status: 400 });
  }

  const result = await verifyMarzpayPhone(body.phone);
  if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: result.status });
  return NextResponse.json({
    success: true,
    data: { phoneNumber: result.phoneNumber, fullName: result.fullName, firstName: result.firstName, lastName: result.lastName },
    cached: result.cached || false,
  }, { headers: { 'Cache-Control': 'private, no-store' } });
}
