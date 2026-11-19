import { NextResponse } from 'next/server';
import { getPool, query } from '@/lib/db.js';
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
        `SELECT p.*, s.name AS staff_name, a.name AS account_name
           FROM payouts p
           JOIN staff s ON s.id = p.staff_id AND s.organization_id = p.organization_id
           JOIN accounts a ON a.id = p.account_id AND a.organization_id = p.organization_id
          WHERE p.id = $1 AND p.organization_id = $2`,
        [id, organizationId]
      );
      if (!result.rows[0]) {
        return NextResponse.json({ success: false, error: 'Payout not found' }, { status: 404 });
      }
      return NextResponse.json({ success: true, data: result.rows[0] });
    });
  } catch (error) {
    console.error('[Payouts] GET/:id error:', error);
    return NextResponse.json({ success: false, error: 'Failed to fetch payout' }, { status: 500 });
  }
}

export async function PATCH(request, { params }) {
  const perm = await requirePermission(request, 'staff.edit');
  if (perm instanceof NextResponse) return perm;
  const organizationId = perm.auth.organizationId;

  try {
    const body = await request.json();
    const allowedStatuses = new Set(['pending', 'processed', 'completed', 'failed', 'cancelled']);
    if (!allowedStatuses.has(body?.status)) {
      return NextResponse.json({ success: false, error: 'Invalid payout status' }, { status: 400 });
    }

    return await runWithOrganizationContext(organizationId, async () => {
      const { id } = await params;
      const client = await getPool().connect();
      try {
        await client.query('BEGIN');
        const existing = await client.query(
          `SELECT id, ledger_transaction_id
             FROM payouts
            WHERE id = $1 AND organization_id = $2
            FOR UPDATE`,
          [id, organizationId]
        );
        if (!existing.rows[0]) {
          await client.query('ROLLBACK');
          return NextResponse.json({ success: false, error: 'Payout not found' }, { status: 404 });
        }
        if (existing.rows[0].ledger_transaction_id) {
          await client.query('ROLLBACK');
          return NextResponse.json({
            success: false,
            error: 'This payout is posted to the ledger. Correct it with an audited reversal or adjustment.',
          }, { status: 409 });
        }
        const result = await client.query(
          `UPDATE payouts
              SET status = $1, processed_at = $2, updated_at = NOW()
            WHERE id = $3 AND organization_id = $4
            RETURNING *`,
          [body.status, body.processed_at || null, id, organizationId]
        );
        await client.query('COMMIT');
        return NextResponse.json({ success: true, data: result.rows[0] });
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[Payouts] PATCH/:id error:', error);
        return NextResponse.json({ success: false, error: 'Failed to update payout' }, { status: 500 });
      } finally {
        await client.release();
      }
    });
  } catch (error) {
    console.error('[Payouts] PATCH/:id error:', error);
    return NextResponse.json({ success: false, error: 'Failed to update payout' }, { status: 500 });
  }
}
