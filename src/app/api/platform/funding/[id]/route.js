import { NextResponse } from 'next/server';
import { getPlatformPool } from '@/lib/db.js';
import { requirePlatformAdmin } from '@/lib/platform/guard.js';

export const runtime = 'nodejs';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function PATCH(request, { params }) {
  const auth = await requirePlatformAdmin(request, { write: true });
  if (auth.response) return auth.response;
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ success: false, error: 'Invalid operation id' }, { status: 400 });
  const body = await request.json().catch(() => null);
  const decision = body?.decision;
  const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 1000) : '';
  if (!['approve', 'reject'].includes(decision) || !reason) return NextResponse.json({ success: false, error: 'Decision and reason are required' }, { status: 400 });

  const client = await getPlatformPool().connect();
  try {
    await client.query('BEGIN');
    const opResult = await client.query('SELECT * FROM public.platform_operations WHERE id = $1 FOR UPDATE', [id]);
    const operation = opResult.rows[0];
    if (!operation) { await client.query('ROLLBACK'); return NextResponse.json({ success: false, error: 'Operation not found' }, { status: 404 }); }
    if (operation.status !== 'pending') { await client.query('ROLLBACK'); return NextResponse.json({ success: false, error: 'Only pending operations can be decided' }, { status: 409 }); }
    if (operation.created_by === auth.user.id) { await client.query('ROLLBACK'); return NextResponse.json({ success: false, error: 'A different platform administrator must review this request' }, { status: 403 }); }

    let transactionId = null;
    if (decision === 'approve' && operation.operation_type === 'institution_deposit') {
      const accountResult = await client.query(
        `SELECT id, name, currency, status, is_active FROM public.accounts
          WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
        [operation.institution_account_id, operation.organization_id]
      );
      const account = accountResult.rows[0];
      if (!account || account.status !== 'active' || account.is_active !== true || account.currency !== operation.currency) {
        await client.query('ROLLBACK');
        return NextResponse.json({ success: false, error: 'Destination account is no longer active or its currency changed' }, { status: 409 });
      }
      const metadata = {
        transaction_scope: 'organization', transaction_type: 'deposit',
        account_id: account.id, reason: operation.purpose, classification: operation.accounting_treatment,
        payment_method: 'other', platform_operation_id: operation.id,
        platform_admin_id: auth.user.id, platform_funding_category: operation.category,
      };
      const tx = await client.query(
        `INSERT INTO public.transactions (organization_id, transaction_type, description, reference, metadata, created_by)
         VALUES ($1, 'deposit', $2, $3, $4::jsonb, NULL) RETURNING id`,
        [operation.organization_id, operation.purpose, `XH-OP-${operation.id}`, JSON.stringify(metadata)]
      );
      transactionId = tx.rows[0].id;
      await client.query(
        `INSERT INTO public.ledger
           (organization_id, account_id, amount, currency, source_type, source_id, description, category, entry_date, metadata, created_by)
         VALUES ($1, $2, $3::numeric, $4, 'deposit', $5, $6, $7, CURRENT_DATE, $8::jsonb, NULL)`,
        [operation.organization_id, account.id, operation.amount, operation.currency, transactionId,
          operation.purpose, operation.category, JSON.stringify(metadata)]
      );
    }

    const nextStatus = decision === 'approve' ? 'approved' : 'rejected';
    await client.query(
      `UPDATE public.platform_operations
          SET status = $2, approved_by = $3, approved_at = NOW(), decision_reason = $4, institution_transaction_id = $5
        WHERE id = $1`,
      [operation.id, nextStatus, auth.user.id, reason, transactionId]
    );
    await client.query(
      `INSERT INTO public.platform_audit_logs (admin_id, action, entity_type, entity_id, details, ip_address)
       VALUES ($1, $2, 'platform_operation', $3, $4::jsonb, $5)`,
      [auth.user.id, `platform_operation_${decision}d`, operation.id,
        JSON.stringify({ operation_type: operation.operation_type, organization_id: operation.organization_id, amount: operation.amount, currency: operation.currency, reason, institution_transaction_id: transactionId }),
        request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null]
    );
    await client.query('COMMIT');
    return NextResponse.json({ success: true, status: nextStatus, institution_transaction_id: transactionId });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[Platform funding] Decision failed:', error);
    return NextResponse.json({ success: false, error: 'Could not record operation decision' }, { status: 500 });
  } finally { client.release(); }
}
