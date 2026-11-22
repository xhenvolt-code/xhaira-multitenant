import { NextResponse } from 'next/server';
import { queryPlatform } from '@/lib/db.js';
import { requirePlatformAdmin } from '@/lib/platform/guard.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function optionalQuery(sql, params = []) {
  try { return await queryPlatform(sql, params); }
  catch (error) {
    if (error.code === '42P01' || error.code === '42703') return { rows: [] };
    throw error;
  }
}

export async function GET(request) {
  const auth = await requirePlatformAdmin(request);
  if (auth.response) return auth.response;
  try {
    const [institutions, people, accounts, money, loans, fees, operations] = await Promise.all([
      queryPlatform(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status = 'active')::int AS active,
                COUNT(*) FILTER (WHERE status = 'suspended')::int AS suspended,
                COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::int AS new_30d
           FROM public.organizations`
      ),
      queryPlatform(
        `SELECT COUNT(*)::int AS members FROM public.members`
      ),
      queryPlatform(
        `SELECT COUNT(*)::int AS accounts FROM public.accounts`
      ),
      queryPlatform(
        `SELECT currency,
                COUNT(DISTINCT source_id) FILTER (WHERE source_type IN ('deposit', 'payment') AND amount > 0)::int AS deposit_count,
                COALESCE(SUM(amount) FILTER (WHERE source_type IN ('deposit', 'payment') AND amount > 0), 0) AS deposits,
                COUNT(DISTINCT source_id) FILTER (WHERE source_type IN ('withdrawal', 'expense', 'transfer_out', 'loan_disbursement') AND amount < 0)::int AS withdrawal_count,
                COALESCE(SUM(ABS(amount)) FILTER (WHERE source_type IN ('withdrawal', 'expense', 'transfer_out', 'loan_disbursement') AND amount < 0), 0) AS withdrawals,
                COALESCE(SUM(ABS(amount)), 0) AS transaction_volume,
                COALESCE(SUM(amount), 0) AS net_movement
           FROM public.ledger GROUP BY currency ORDER BY currency`
      ),
      optionalQuery(
        `SELECT COUNT(*) FILTER (WHERE status IN ('ACTIVE', 'APPROVED'))::int AS outstanding_count,
                COALESCE(SUM(GREATEST(total_payable - total_paid, 0)) FILTER (WHERE status IN ('ACTIVE', 'APPROVED')), 0) AS outstanding_amount
           FROM public.loans`
      ),
      optionalQuery(
        `SELECT currency,
                COALESCE(SUM(COALESCE((fee_calculation->>'xhenvoltRevenueMinor')::numeric, 0)), 0) /
                  CASE WHEN currency = 'UGX' THEN 1 ELSE 100 END AS transaction_fees
           FROM public.payment_intents WHERE status = 'settled' GROUP BY currency ORDER BY currency`
      ),
      queryPlatform(
        `SELECT currency,
                COALESCE(SUM(amount) FILTER (WHERE operation_type = 'platform_revenue' AND status = 'approved'), 0) AS other_revenue,
                COALESCE(SUM(amount) FILTER (WHERE operation_type = 'operational_expense' AND status = 'approved'), 0) AS operational_spend,
                COALESCE(SUM(amount) FILTER (WHERE operation_type = 'operational_advance' AND status = 'approved'), 0)
                  - COALESCE(SUM(amount) FILTER (WHERE operation_type = 'reimbursement' AND status = 'approved'), 0) AS outstanding_advances
           FROM public.platform_operations GROUP BY currency ORDER BY currency`
      ),
    ]);
    const row = result => result.rows[0] || {};
    const feesByCurrency = fees.rows || [];
    const operationCurrencies = operations.rows || [];
    return NextResponse.json({
      success: true,
      metrics: {
        institutions: row(institutions), members: Number(row(people).members || 0),
        accounts: Number(row(accounts).accounts || 0), transactions: money.rows, loans: row(loans),
        revenue: {
          fees_by_currency: feesByCurrency,
          operations_by_currency: operationCurrencies,
        },
      },
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[Platform dashboard] Failed to aggregate metrics:', error);
    return NextResponse.json({ success: false, error: 'Failed to load platform metrics' }, { status: 500 });
  }
}
