import { NextResponse } from 'next/server';
import { getPool, query } from '@/lib/db.js';
import { requirePermission } from '@/lib/permissions.js';
import { runWithOrganizationContext } from '@/lib/organization-context.js';
import { ensureEmployeeWallet } from '@/lib/employee-account-service.js';

export async function GET(request) {
  const perm = await requirePermission(request, 'staff.view');
  if (perm instanceof NextResponse) return perm;
  const organizationId = perm.auth.organizationId;

  try {
    return await runWithOrganizationContext(organizationId, async () => {
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
          WHERE ea.organization_id = $1
          GROUP BY ea.id, s.name, a.name
          ORDER BY s.name, ea.created_at`,
        [organizationId]
      );
      return NextResponse.json({ success: true, data: result.rows });
    });
  } catch (error) {
    console.error('[Employee Accounts] GET error:', error);
    return NextResponse.json({ success: false, error: 'Failed to fetch employee accounts' }, { status: 500 });
  }
}

export async function POST(request) {
  const perm = await requirePermission(request, 'staff.edit');
  if (perm instanceof NextResponse) return perm;
  const organizationId = perm.auth.organizationId;

  try {
    const body = await request.json();
    const staffId = body?.staff_id;
    if (typeof staffId !== 'string') {
      return NextResponse.json({ success: false, error: 'staff_id is required' }, { status: 400 });
    }

    return await runWithOrganizationContext(organizationId, async () => {
      const client = await getPool().connect();
      try {
        await client.query('BEGIN');
        const wallet = await ensureEmployeeWallet(client, {
          staffId,
          organizationId,
          currency: 'UGX',
        });
        await client.query(
          `INSERT INTO audit_logs
             (organization_id, user_id, action, entity_type, entity_id, details)
           VALUES ($1, $2, 'CREATE', 'employee_account', $3, $4)`,
          [
            organizationId,
            perm.auth.userId,
            wallet.id,
            JSON.stringify({ staff_id: staffId, account_id: wallet.account_id, currency: 'UGX' }),
          ]
        );
        await client.query('COMMIT');
        return NextResponse.json({ success: true, data: wallet }, { status: 201 });
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        if (error.code === '23505') {
          return NextResponse.json({ success: false, error: 'An employee wallet already exists.' }, { status: 409 });
        }
        console.error('[Employee Accounts] POST error:', error);
        return NextResponse.json({ success: false, error: 'Failed to create employee wallet' }, { status: 500 });
      } finally {
        await client.release();
      }
    });
  } catch (error) {
    console.error('[Employee Accounts] POST error:', error);
    return NextResponse.json({ success: false, error: 'Failed to create employee wallet' }, { status: 500 });
  }
}
