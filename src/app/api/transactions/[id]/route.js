import { NextResponse } from 'next/server';
import { getPool, query } from '@/lib/db.js';
import { requirePermission } from '@/lib/permissions.js';
import { runWithOrganizationContext } from '@/lib/organization-context.js';

// GET /api/transactions/[id] — Get transaction with all ledger entries
export async function GET(request, { params }) {
  try {
    const perm = await requirePermission(request, 'finance.view');
    if (perm instanceof NextResponse) return perm;
    return await runWithOrganizationContext(perm.auth.organizationId, async () => {

    const { id } = await params;

    const [txResult, entriesResult] = await Promise.all([
      query(
        `SELECT t.*, u.email as created_by_email
         FROM transactions t
         LEFT JOIN users u ON t.created_by = u.id AND u.organization_id = t.organization_id
         WHERE t.id = $1 AND t.organization_id = $2`,
        [id, perm.auth.organizationId]
      ),
      query(
        `SELECT le.*, 
           ma.account_number as member_account_number, ma.account_type as member_account_type,
           a.name as account_name, a.type as system_account_type
         FROM ledger_entries le
         LEFT JOIN member_accounts ma ON le.member_account_id = ma.id AND ma.organization_id = $2
         LEFT JOIN accounts a ON le.account_id = a.id AND a.organization_id = $2
         WHERE le.transaction_id = $1 AND le.organization_id = $2
         ORDER BY le.entry_type, le.created_at`,
        [id, perm.auth.organizationId]
      ),
    ]);

    if (txResult.rows.length === 0) {
      return NextResponse.json({ success: false, error: 'Transaction not found' }, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      data: {
        ...txResult.rows[0],
        entries: entriesResult.rows,
      },
    });
    });
  } catch (error) {
    console.error('[Transaction Detail] GET error:', error.message);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function DELETE(request, { params }) {
  try {
    const perm = await requirePermission(request, 'finance.manage');
    if (perm instanceof NextResponse) return perm;
    const organizationId = perm.auth.organizationId;
    const { id } = await params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(id || ''))) {
      return NextResponse.json({ success: false, error: 'Transaction not found' }, { status: 404 });
    }

    return await runWithOrganizationContext(organizationId, async () => {
      const client = await getPool().connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.organization_id', $1, true)", [organizationId]);
        await client.query("SELECT set_config('app.allow_transaction_delete', 'on', true)");
        const deleted = await client.query(
          `DELETE FROM public.transactions
            WHERE id = $1 AND organization_id = $2
            RETURNING id, transaction_type, description, receipt_number`,
          [id, organizationId]
        );
        if (!deleted.rows[0]) {
          await client.query('ROLLBACK');
          return NextResponse.json({ success: false, error: 'Transaction not found' }, { status: 404 });
        }
        await client.query(
          `INSERT INTO public.audit_logs
             (organization_id, user_id, action, entity_type, entity_id, details)
           VALUES ($1, $2, 'DELETE', 'transaction', $3, $4)`,
          [organizationId, perm.auth.userId, id, JSON.stringify({
            transaction_type: deleted.rows[0].transaction_type,
            description: deleted.rows[0].description,
            receipt_number: deleted.rows[0].receipt_number,
          })]
        );
        await client.query('COMMIT');
        return NextResponse.json({ success: true, data: { id, deleted: true } });
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        await client.release();
      }
    });
  } catch (error) {
    console.error('[Transaction] DELETE error:', error.message);
    if (error.code === '23503') {
      return NextResponse.json({ success: false, error: 'A linked record prevented transaction deletion. Apply migration 978 and retry.' }, { status: 409 });
    }
    if (error.code === '42501' || /immutable/i.test(error.message || '')) {
      return NextResponse.json({ success: false, error: 'Transaction deletion is unavailable until migration 978 is applied.' }, { status: 409 });
    }
    return NextResponse.json({ success: false, error: 'Failed to delete transaction' }, { status: 500 });
  }
}
