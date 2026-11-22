import { NextResponse } from 'next/server';
import { getPlatformPool, queryPlatform } from '@/lib/db.js';
import { requirePlatformAdmin } from '@/lib/platform/guard.js';

export const runtime = 'nodejs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request, { params }) {
  const auth = await requirePlatformAdmin(request);
  if (auth.response) return auth.response;
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ success: false, error: 'Invalid institution id' }, { status: 400 });
  try {
    const result = await queryPlatform(
      `SELECT o.id, o.name, o.slug AS institution_code, o.institution_type, o.status, o.created_at, o.updated_at,
              (SELECT COUNT(*)::int FROM public.members m WHERE m.organization_id = o.id) AS member_count,
              (SELECT COUNT(*)::int FROM public.accounts a WHERE a.organization_id = o.id) AS account_count,
              (SELECT jsonb_agg(jsonb_build_object('account_id', account_id, 'name', name, 'type', type,
                    'currency', currency, 'balance', balance, 'transaction_count', transaction_count)
                  ORDER BY name)
                 FROM public.v_account_balances
                WHERE account_id IN (SELECT a.id FROM public.accounts a WHERE a.organization_id = o.id)
              ) AS accounts,
              (SELECT COUNT(*)::int FROM public.ledger l WHERE l.organization_id = o.id AND l.source_type IN ('deposit', 'payment') AND l.amount > 0) AS deposit_count,
              (SELECT jsonb_object_agg(currency, amount) FROM (
                 SELECT l.currency, SUM(l.amount) AS amount FROM public.ledger l
                  WHERE l.organization_id = o.id AND l.source_type IN ('deposit', 'payment') AND l.amount > 0 GROUP BY l.currency
               ) d) AS deposits_by_currency,
              (SELECT COUNT(*)::int FROM public.ledger l WHERE l.organization_id = o.id AND l.source_type IN ('withdrawal', 'expense', 'transfer_out', 'loan_disbursement') AND l.amount < 0) AS withdrawal_count,
              (SELECT jsonb_object_agg(currency, amount) FROM (
                 SELECT l.currency, SUM(ABS(l.amount)) AS amount FROM public.ledger l
                  WHERE l.organization_id = o.id AND l.source_type IN ('withdrawal', 'expense', 'transfer_out', 'loan_disbursement') AND l.amount < 0 GROUP BY l.currency
               ) w) AS withdrawals_by_currency,
              (SELECT MAX(l.created_at) FROM public.ledger l WHERE l.organization_id = o.id) AS last_activity
         FROM public.organizations o WHERE o.id = $1`, [id]
    );
    if (!result.rows[0]) return NextResponse.json({ success: false, error: 'Institution not found' }, { status: 404 });
    return NextResponse.json({ success: true, data: result.rows[0] }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[Platform institution] Read failed:', error);
    return NextResponse.json({ success: false, error: 'Failed to load institution details' }, { status: 500 });
  }
}

export async function PATCH(request, { params }) {
  const auth = await requirePlatformAdmin(request, { write: true });
  if (auth.response) return auth.response;
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ success: false, error: 'Invalid institution id' }, { status: 400 });
  const body = await request.json().catch(() => null);
  const targetStatus = body?.status;
  const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 1000) : '';
  if (!['active', 'suspended'].includes(targetStatus) || !reason) {
    return NextResponse.json({ success: false, error: 'A valid status and reason are required' }, { status: 400 });
  }
  const client = await getPlatformPool().connect();
  try {
    await client.query('BEGIN');
    const org = await client.query('SELECT id, name, status FROM public.organizations WHERE id = $1 FOR UPDATE', [id]);
    if (!org.rows[0]) {
      await client.query('ROLLBACK');
      return NextResponse.json({ success: false, error: 'Institution not found' }, { status: 404 });
    }
    if (org.rows[0].status === targetStatus) {
      await client.query('ROLLBACK');
      return NextResponse.json({ success: false, error: `Institution is already ${targetStatus}` }, { status: 409 });
    }
    await client.query('UPDATE public.organizations SET status = $2, updated_at = NOW() WHERE id = $1', [id, targetStatus]);
    if (targetStatus === 'suspended') {
      await client.query('SELECT public.revoke_organization_sessions($1)', [id]);
    }
    await client.query(
      `INSERT INTO public.platform_audit_logs (admin_id, action, entity_type, entity_id, details, ip_address)
       VALUES ($1, $2, 'institution', $3, $4::jsonb, $5)`,
      [auth.user.id, targetStatus === 'suspended' ? 'institution_suspended' : 'institution_reactivated', id,
        JSON.stringify({ name: org.rows[0].name, old_status: org.rows[0].status, new_status: targetStatus, reason }),
        request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null]
    );
    await client.query('COMMIT');
    return NextResponse.json({ success: true, data: { id, name: org.rows[0].name, status: targetStatus } });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[Platform institution] Status update failed:', error);
    return NextResponse.json({ success: false, error: 'Failed to update institution status' }, { status: 500 });
  } finally {
    client.release();
  }
}
