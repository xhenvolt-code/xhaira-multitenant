import { NextResponse } from 'next/server';
import { query } from '@/lib/db.js';
import { dispatch } from '@/lib/system-events.js';
import { requirePermission } from '@/lib/permissions.js';
import { runWithOrganizationContext } from '@/lib/organization-context.js';

// GET /api/transfers
export async function GET(request) {
  try {
    const perm = await requirePermission(request, 'finance.view');
    if (perm instanceof NextResponse) return perm;
    const { auth } = perm;
    return await runWithOrganizationContext(auth.organizationId, async () => {
      const result = await query(
        `SELECT t.*, fa.name as from_account_name, ta.name as to_account_name
           FROM public.transfers t
           JOIN public.accounts fa
             ON t.from_account_id = fa.id AND fa.organization_id = t.organization_id
           JOIN public.accounts ta
             ON t.to_account_id = ta.id AND ta.organization_id = t.organization_id
          WHERE t.organization_id = $1
          ORDER BY t.transfer_date DESC`,
        [auth.organizationId]
      );
      return NextResponse.json({ success: true, data: result.rows });
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: 'Failed to fetch transfers' }, { status: 500 });
  }
}

// POST /api/transfers - Create transfer WITH two ledger entries
export async function POST(request) {
  try {
    const perm = await requirePermission(request, 'finance.create');
    if (perm instanceof NextResponse) return perm;
    const { auth } = perm;
    return await runWithOrganizationContext(auth.organizationId, async () => {

    const body = await request.json();
    const { from_account_id, to_account_id, amount, currency, to_amount, to_currency, exchange_rate, description, reference, transfer_date } = body;
    
    if (!from_account_id || !to_account_id || !amount) {
      return NextResponse.json({ success: false, error: 'from_account_id, to_account_id, and amount are required' }, { status: 400 });
    }
    if (from_account_id === to_account_id) {
      return NextResponse.json({ success: false, error: 'Cannot transfer to same account' }, { status: 400 });
    }

    const accountGuard = await query(
      `SELECT a.id, a.type,
              EXISTS (
                SELECT 1
                  FROM employee_accounts ea
                 WHERE ea.account_id = a.id
                   AND ea.organization_id = a.organization_id
              ) AS is_staff_wallet
         FROM accounts a
        WHERE a.id = ANY($1::uuid[])
          AND a.organization_id = $2`,
      [[from_account_id, to_account_id], auth.organizationId]
    );
    if (accountGuard.rows.length !== 2) {
      return NextResponse.json({ success: false, error: 'One or both accounts were not found in this organization' }, { status: 404 });
    }
    if (accountGuard.rows.some(account => account.is_staff_wallet)) {
      return NextResponse.json({ success: false, error: 'Staff wallets can only be credited through payroll; use the Employee Accounts workflow.' }, { status: 400 });
    }
    if (accountGuard.rows.some(account => account.type === 'internal')) {
      return NextResponse.json({ success: false, error: 'Internal accounts cannot use standard organization transfers.' }, { status: 400 });
    }

    const txDate = transfer_date || new Date().toISOString().split('T')[0];

    // Get account names for description
    const fromAcct = await query(
      `SELECT name FROM public.accounts WHERE id = $1 AND organization_id = $2`,
      [from_account_id, auth.organizationId]
    );
    const toAcct = await query(
      `SELECT name FROM public.accounts WHERE id = $1 AND organization_id = $2`,
      [to_account_id, auth.organizationId]
    );

    const transferResult = await query(
      `INSERT INTO public.transfers (organization_id, from_account_id, to_account_id, amount, currency, to_amount, to_currency, exchange_rate, description, reference, transfer_date, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'completed',$12) RETURNING *`,
      [auth.organizationId, from_account_id, to_account_id, amount, currency||'UGX', to_amount||null, to_currency||null,
       exchange_rate||null, description||null, reference||null, txDate, auth.userId]
    );

    const transfer = transferResult.rows[0];
    const fromName = fromAcct.rows[0]?.name || 'Unknown';
    const toName = toAcct.rows[0]?.name || 'Unknown';

    // Create DEBIT ledger entry (money out of from_account)
    const debitResult = await query(
      `INSERT INTO public.ledger (organization_id, account_id, amount, currency, source_type, source_id, description, category, entry_date, created_by)
       VALUES ($1,$2,$3,$4,'transfer_out',$5,$6,'transfer',$7,$8) RETURNING id`,
      [auth.organizationId, from_account_id, -Math.abs(amount), currency||'UGX', transfer.id,
       `Transfer to ${toName}${description ? ': ' + description : ''}`, txDate, auth.userId]
    );

    // Create CREDIT ledger entry (money into to_account)
    const creditAmount = to_amount || amount;
    const creditCurrency = to_currency || currency || 'UGX';
    const creditResult = await query(
      `INSERT INTO public.ledger (organization_id, account_id, amount, currency, source_type, source_id, description, category, entry_date, created_by)
       VALUES ($1,$2,$3,$4,'transfer_in',$5,$6,'transfer',$7,$8) RETURNING id`,
      [auth.organizationId, to_account_id, Math.abs(creditAmount), creditCurrency, transfer.id,
       `Transfer from ${fromName}${description ? ': ' + description : ''}`, txDate, auth.userId]
    );

    // Link ledger entries back to transfer
    await query(`UPDATE public.transfers SET ledger_debit_id = $1, ledger_credit_id = $2 WHERE id = $3 AND organization_id = $4`,
      [debitResult.rows[0].id, creditResult.rows[0].id, transfer.id, auth.organizationId]);

    dispatch('transfer_completed', { entityType: 'transfer', entityId: transfer.id, description: `Transfer: ${currency || 'UGX'} ${Number(amount).toLocaleString()} from ${fromName} to ${toName}`, metadata: { amount, currency: currency || 'UGX', from: fromName, to: toName }, actorId: auth.userId }).catch(() => {});

    return NextResponse.json({ success: true, data: transfer }, { status: 201 });
    });
  } catch (error) {
    console.error('[Transfers] POST error:', error);
    return NextResponse.json({ success: false, error: 'Failed to create transfer' }, { status: 500 });
  }
}
