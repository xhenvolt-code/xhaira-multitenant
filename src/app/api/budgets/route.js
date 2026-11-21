import { NextResponse } from 'next/server';
import { query } from '@/lib/db.js';
import { requirePermission } from '@/lib/permissions.js';
import { runWithOrganizationContext } from '@/lib/organization-context.js';

// GET /api/budgets
export async function GET(request) {
  try {
    const perm = await requirePermission(request, 'budgets', 'view');
    if (perm instanceof NextResponse) return perm;
    const { auth } = perm;
    return await runWithOrganizationContext(auth.organizationId, async () => {
    const result = await query(
      `SELECT b.*,
              b.start_date AS period_start,
              b.end_date AS period_end,
              COALESCE(SUM(e.amount) FILTER (WHERE e.status NOT IN ('void', 'rejected')), 0) AS spent,
              COUNT(e.id) FILTER (WHERE e.status NOT IN ('void', 'rejected'))::int AS expense_count
       FROM budgets b
       LEFT JOIN expenses e
         ON e.budget_id = b.id
        AND e.organization_id = b.organization_id
        AND e.expense_date BETWEEN b.start_date AND b.end_date
       WHERE b.organization_id = $1
       GROUP BY b.id
       ORDER BY b.start_date DESC`,
      [auth.organizationId]
    );
    return NextResponse.json({ success: true, data: result.rows });
    });
  } catch (error) {
    console.error('[Budgets] GET error:', error.message);
    return NextResponse.json({ success: false, error: 'Failed to fetch budgets' }, { status: 500 });
  }
}

// POST /api/budgets
export async function POST(request) {
  try {
    const perm = await requirePermission(request, 'budgets', 'create');
    if (perm instanceof NextResponse) return perm;
    const { auth } = perm;
    if (!auth.organizationId) return NextResponse.json({ success: false, error: 'Organization context required' }, { status: 400 });
    return await runWithOrganizationContext(auth.organizationId, async () => {
    const body = await request.json();
    const { name, category = 'other', amount, currency, period, start_date, end_date, alert_threshold, notes } = body;
    if (!name || amount == null || Number(amount) <= 0 || !period || !start_date || !end_date) {
      return NextResponse.json({ success: false, error: 'name, positive amount, period, start_date, and end_date are required' }, { status: 400 });
    }
    const result = await query(
      `INSERT INTO budgets (name, category, amount, currency, period, start_date, end_date, alert_threshold, notes, created_by, organization_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [name, category || 'other', amount, currency || 'UGX', period, start_date, end_date, alert_threshold ?? 80, notes || null, auth.userId, auth.organizationId]
    );
    return NextResponse.json({ success: true, data: result.rows[0] }, { status: 201 });
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: 'Failed to create budget' }, { status: 500 });
  }
}
