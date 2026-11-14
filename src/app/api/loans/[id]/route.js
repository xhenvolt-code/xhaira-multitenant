import { NextResponse } from 'next/server';
import { query } from '@/lib/db.js';
import { requirePermission } from '@/lib/permissions.js';

// GET /api/loans/[id] — Loan detail with schedule, guarantors, disbursement info
export async function GET(request, { params }) {
  try {
    const perm = await requirePermission(request, 'finance.view');
    if (perm instanceof NextResponse) return perm;
    const { auth } = perm;

    const { id } = await params;

    const [loanResult, scheduleResult, guarantorResult] = await Promise.all([
      query(
        `SELECT l.*, m.full_name as member_name, m.membership_number,
           p.name as product_name, p.product_type,
           ma.account_number as member_account_number,
           u.email as approved_by_email
         FROM loans l
         JOIN members m ON m.id = l.member_id AND m.organization_id = l.organization_id
         LEFT JOIN products p ON p.id = l.product_id AND p.organization_id = l.organization_id
         LEFT JOIN member_accounts ma ON ma.id = l.member_account_id AND ma.organization_id = l.organization_id
         LEFT JOIN users u ON u.id = l.approved_by AND u.organization_id = l.organization_id
         WHERE l.id = $1 AND l.organization_id = $2`,
        [id, auth.organizationId]
      ),
      query(
        `SELECT * FROM loan_schedules WHERE loan_id = $1 AND organization_id = $2 ORDER BY installment_number ASC`,
        [id, auth.organizationId]
      ),
      query(
        `SELECT lg.*, m.full_name, m.membership_number
         FROM loan_guarantors lg
         JOIN members m ON lg.guarantor_member_id = m.id AND m.organization_id = lg.organization_id
         WHERE lg.loan_id = $1 AND lg.organization_id = $2 ORDER BY lg.created_at`,
        [id, auth.organizationId]
      ),
    ]);

    if (loanResult.rows.length === 0) {
      return NextResponse.json({ success: false, error: 'Loan not found' }, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      data: {
        ...loanResult.rows[0],
        schedule: scheduleResult.rows,
        guarantors: guarantorResult.rows,
      },
    });
  } catch (error) {
    console.error('[Loan Detail] GET error:', error.message);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
