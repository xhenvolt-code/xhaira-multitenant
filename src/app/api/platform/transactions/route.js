import { NextResponse } from 'next/server';
import { queryPlatform } from '@/lib/db.js';
import { requirePlatformAdmin } from '@/lib/platform/guard.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function kampalaToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kampala', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function shiftDate(date, amount) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}
function validDate(value) {
  return DATE.test(value || '') && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

export async function GET(request) {
  const auth = await requirePlatformAdmin(request);
  if (auth.response) return auth.response;
  const { searchParams } = new URL(request.url);
  const period = searchParams.get('period') || 'monthly';
  const today = kampalaToday();
  let fromDate;
  let toDate;
  if (period === 'custom') {
    fromDate = searchParams.get('from') || '';
    toDate = searchParams.get('to') || '';
    if (!validDate(fromDate) || !validDate(toDate) || fromDate > toDate) {
      return NextResponse.json({ success: false, error: 'Custom ranges require valid from and to dates' }, { status: 400 });
    }
  } else if (period === 'daily') { fromDate = today; toDate = today; }
  else if (period === 'weekly') { fromDate = shiftDate(today, -6); toDate = today; }
  else if (period === 'monthly') { fromDate = `${today.slice(0, 7)}-01`; toDate = today; }
  else if (period === 'annual') { fromDate = `${today.slice(0, 4)}-01-01`; toDate = today; }
  else return NextResponse.json({ success: false, error: 'period must be daily, weekly, monthly, annual, or custom' }, { status: 400 });

  const filters = [fromDate, toDate];
  let where = 'l.entry_date BETWEEN $1::date AND $2::date';
  const institutionId = searchParams.get('institution_id');
  const accountType = searchParams.get('account_type');
  const transactionType = searchParams.get('transaction_type');
  const paymentMethod = searchParams.get('payment_method');
  const status = searchParams.get('status');
  if (institutionId) { filters.push(institutionId); where += ` AND l.organization_id = $${filters.length}`; }
  if (accountType) { filters.push(accountType); where += ` AND a.type = $${filters.length}`; }
  if (transactionType) { filters.push(transactionType); where += ` AND l.source_type = $${filters.length}`; }
  if (paymentMethod) { filters.push(paymentMethod); where += ` AND COALESCE(l.metadata->>'payment_method', 'unknown') = $${filters.length}`; }
  if (status) { filters.push(status); where += ` AND COALESCE(pi.status, l.metadata->>'status', 'completed') = $${filters.length}`; }

  try {
    const [rows, summary] = await Promise.all([
      queryPlatform(
        `SELECT o.id AS institution_id, o.name AS institution_name, l.source_type AS transaction_type,
                COALESCE(l.metadata->>'payment_method', 'unknown') AS payment_method,
                COALESCE(pi.status, l.metadata->>'status', 'completed') AS status,
                COUNT(*)::int AS transaction_count, COALESCE(SUM(ABS(l.amount)), 0) AS transaction_volume,
                COALESCE(SUM(l.amount), 0) AS net_movement,
                COUNT(*) FILTER (WHERE l.amount > 0)::int AS deposit_count,
                COALESCE(SUM(l.amount) FILTER (WHERE l.amount > 0), 0) AS deposit_amount,
                COUNT(*) FILTER (WHERE l.amount < 0)::int AS withdrawal_count,
                COALESCE(SUM(ABS(l.amount)) FILTER (WHERE l.amount < 0), 0) AS withdrawal_amount,
                l.currency
           FROM public.ledger l
           JOIN public.organizations o ON o.id = l.organization_id
           JOIN public.accounts a ON a.id = l.account_id AND a.organization_id = l.organization_id
           LEFT JOIN public.payment_intents pi ON pi.organization_id = l.organization_id AND pi.transaction_id = l.source_id
          WHERE ${where}
          GROUP BY o.id, o.name, l.source_type, l.currency, payment_method, status
          ORDER BY o.name, l.source_type, l.currency`, filters
      ),
      queryPlatform(
        `SELECT l.currency, COUNT(*)::int AS transaction_count, COALESCE(SUM(ABS(l.amount)), 0) AS transaction_volume,
                COALESCE(SUM(l.amount), 0) AS net_movement,
                COUNT(*) FILTER (WHERE l.amount > 0)::int AS deposit_count,
                COALESCE(SUM(l.amount) FILTER (WHERE l.amount > 0), 0) AS deposit_amount,
                COUNT(*) FILTER (WHERE l.amount < 0)::int AS withdrawal_count,
                COALESCE(SUM(ABS(l.amount)) FILTER (WHERE l.amount < 0), 0) AS withdrawal_amount
           FROM public.ledger l
           JOIN public.accounts a ON a.id = l.account_id AND a.organization_id = l.organization_id
           LEFT JOIN public.payment_intents pi ON pi.organization_id = l.organization_id AND pi.transaction_id = l.source_id
          WHERE ${where} GROUP BY l.currency ORDER BY l.currency`, filters
      ),
    ]);
    return NextResponse.json({ success: true, range: { period, from: fromDate, to: toDate }, summary: summary.rows, data: rows.rows }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[Platform transactions] Query failed:', error);
    return NextResponse.json({ success: false, error: 'Failed to load institution activity' }, { status: 500 });
  }
}
