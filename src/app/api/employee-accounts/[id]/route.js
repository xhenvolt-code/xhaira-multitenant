import { NextResponse } from 'next/server';
import { query } from '@/lib/db.js';
import { requirePermission } from '@/lib/permissions.js';
import { runWithOrganizationContext } from '@/lib/organization-context.js';

export async function GET(request, { params }) {
  const perm = await requirePermission(request, 'staff.view');
  if (perm instanceof NextResponse) return perm;
  const organizationId = perm.auth.organizationId;

  try {
    return await runWithOrganizationContext(organizationId, async () => {
      const { id } = await params;
      const result = await query(
        `SELECT ea.id, ea.organization_id, ea.staff_id, ea.account_id, ea.currency,
                ea.status, ea.notes, ea.created_at, ea.updated_at,
                s.name AS staff_name, a.name AS account_name,
                COALESCE(SUM(
                  CASE WHEN le.entry_type = 'CREDIT' THEN le.amount
                       WHEN le.entry_type = 'DEBIT' THEN -le.amount
                       ELSE 0 END
                ), 0) AS balance
           FROM employee_accounts ea
           JOIN staff s ON s.id = ea.staff_id AND s.organization_id = ea.organization_id
           JOIN accounts a ON a.id = ea.account_id AND a.organization_id = ea.organization_id
           LEFT JOIN ledger_entries le
             ON le.employee_account_id = ea.id
            AND le.organization_id = ea.organization_id
          WHERE ea.id = $1 AND ea.organization_id = $2
          GROUP BY ea.id, s.name, a.name`,
        [id, organizationId]
      );
      if (!result.rows[0]) {
        return NextResponse.json({ success: false, error: 'Employee wallet not found' }, { status: 404 });
      }
      return NextResponse.json({ success: true, data: result.rows[0] });
    });
  } catch (error) {
    console.error('[Employee Account] GET error:', error);
    return NextResponse.json({ success: false, error: 'Failed to fetch employee wallet' }, { status: 500 });
  }
}

export async function PATCH(request, { params }) {
  const perm = await requirePermission(request, 'staff.edit');
  if (perm instanceof NextResponse) return perm;
  const organizationId = perm.auth.organizationId;

  try {
    const body = await request.json();
    if (Object.prototype.hasOwnProperty.call(body || {}, 'balance')) {
      return NextResponse.json({ success: false, error: 'Wallet balance is ledger-derived and cannot be edited.' }, { status: 400 });
    }
    const { status, notes } = body || {};
    if (status !== undefined && !['active', 'suspended', 'closed'].includes(status)) {
      return NextResponse.json({ success: false, error: 'Invalid employee wallet status' }, { status: 400 });
    }
    if (notes !== undefined && typeof notes !== 'string' && notes !== null) {
      return NextResponse.json({ success: false, error: 'notes must be a string or null' }, { status: 400 });
    }

    return await runWithOrganizationContext(organizationId, async () => {
      const { id } = await params;
      const result = await query(
        `UPDATE employee_accounts
            SET status = COALESCE($1, status),
                notes = COALESCE($2, notes),
                updated_at = NOW()
          WHERE id = $3 AND organization_id = $4
          RETURNING id, staff_id, account_id, currency, status, notes, updated_at`,
        [status ?? null, notes ?? null, id, organizationId]
      );
      if (!result.rows[0]) {
        return NextResponse.json({ success: false, error: 'Employee wallet not found' }, { status: 404 });
      }
      return NextResponse.json({ success: true, data: result.rows[0] });
    });
  } catch (error) {
    console.error('[Employee Account] PATCH error:', error);
    return NextResponse.json({ success: false, error: 'Failed to update employee wallet' }, { status: 500 });
  }
}

export async function DELETE(request, { params }) {
  const perm = await requirePermission(request, 'staff.delete');
  if (perm instanceof NextResponse) return perm;
  const organizationId = perm.auth.organizationId;

  try {
    return await runWithOrganizationContext(organizationId, async () => {
      const { id } = await params;
      const result = await query(
        `UPDATE employee_accounts
            SET status = 'closed', updated_at = NOW()
          WHERE id = $1 AND organization_id = $2
          RETURNING id`,
        [id, organizationId]
      );
      if (!result.rows[0]) {
        return NextResponse.json({ success: false, error: 'Employee wallet not found' }, { status: 404 });
      }
      return NextResponse.json({ success: true, data: result.rows[0] });
    });
  } catch (error) {
    console.error('[Employee Account] DELETE error:', error);
    return NextResponse.json({ success: false, error: 'Failed to close employee wallet' }, { status: 500 });
  }
}
