import { NextResponse } from 'next/server';
import { queryPlatform } from '@/lib/db.js';
import { requirePlatformAdmin } from '@/lib/platform/guard.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request) {
  const auth = await requirePlatformAdmin(request);
  if (auth.response) return auth.response;
  const { searchParams } = new URL(request.url);
  const search = String(searchParams.get('q') || '').trim().slice(0, 120);
  const status = searchParams.get('status');
  const page = Math.max(1, Number.parseInt(searchParams.get('page') || '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(searchParams.get('limit') || '25', 10) || 25));
  const offset = (page - 1) * limit;
  const params = [];
  let where = 'TRUE';
  if (search) {
    params.push(`%${search}%`);
    where += ` AND (o.name ILIKE $${params.length} OR o.slug ILIKE $${params.length})`;
  }
  if (status && ['active', 'suspended'].includes(status)) {
    params.push(status);
    where += ` AND o.status = $${params.length}`;
  }
  try {
    const [count, rows] = await Promise.all([
      queryPlatform(`SELECT COUNT(*)::int AS total FROM public.organizations o WHERE ${where}`, params),
      queryPlatform(
        `SELECT o.id, o.name, o.slug AS institution_code, o.status, o.created_at,
                (SELECT COUNT(*)::int FROM public.members m WHERE m.organization_id = o.id) AS member_count,
                (SELECT COUNT(*)::int FROM public.accounts a WHERE a.organization_id = o.id) AS account_count,
                (SELECT jsonb_object_agg(currency, balance) FROM (
                  SELECT a.currency, COALESCE(SUM(l.amount), 0) AS balance
                    FROM public.accounts a LEFT JOIN public.ledger l
                      ON l.account_id = a.id AND l.organization_id = a.organization_id
                   WHERE a.organization_id = o.id
                   GROUP BY a.currency
                ) account_currency_balances) AS account_balances_by_currency,
                (SELECT jsonb_object_agg(currency, amount) FROM (
                   SELECT l.currency, SUM(l.amount) AS amount FROM public.ledger l
                    WHERE l.organization_id = o.id AND l.amount > 0 AND l.source_type IN ('deposit', 'payment') GROUP BY l.currency
                 ) deposits_by_currency) AS deposits,
                (SELECT jsonb_object_agg(currency, amount) FROM (
                   SELECT l.currency, SUM(ABS(l.amount)) AS amount FROM public.ledger l
                    WHERE l.organization_id = o.id AND l.amount < 0 AND l.source_type IN ('withdrawal', 'expense', 'transfer_out', 'loan_disbursement') GROUP BY l.currency
                 ) withdrawals_by_currency) AS withdrawals,
                NULLIF(GREATEST(
                  COALESCE((SELECT MAX(t.created_at) FROM public.transactions t WHERE t.organization_id = o.id), '-infinity'::timestamptz),
                  COALESCE((SELECT MAX(l.created_at) FROM public.ledger l WHERE l.organization_id = o.id), '-infinity'::timestamptz)
                ), '-infinity'::timestamptz) AS last_activity
           FROM public.organizations o
          WHERE ${where}
          ORDER BY o.created_at DESC, o.id
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
    ]);
    return NextResponse.json({ success: true, data: rows.rows, pagination: { page, limit, total: count.rows[0].total, totalPages: Math.max(1, Math.ceil(count.rows[0].total / limit)) } }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[Platform institutions] List failed:', error);
    return NextResponse.json({ success: false, error: 'Failed to load institutions' }, { status: 500 });
  }
}
