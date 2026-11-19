import { NextResponse } from 'next/server';
import { getPool, query } from '@/lib/db.js';
import { requirePermission } from '@/lib/permissions.js';
import { runWithOrganizationContext } from '@/lib/organization-context.js';
import { createTransaction } from '@/lib/transaction-service.js';
import { ensureEmployeeWallet } from '@/lib/employee-account-service.js';

const PAYOUT_TYPES = new Set(['salary', 'bonus', 'commission', 'reimbursement', 'advance', 'other']);
const IDEMPOTENCY_KEY_PATTERN = /^[\w:.-]{8,128}$/;

export async function GET(request) {
  const perm = await requirePermission(request, 'staff.view');
  if (perm instanceof NextResponse) return perm;
  const organizationId = perm.auth.organizationId;

  try {
    return await runWithOrganizationContext(organizationId, async () => {
      const { searchParams } = new URL(request.url);
      const staffId = searchParams.get('staff_id');
      const status = searchParams.get('status');
      const payoutType = searchParams.get('payout_type');
      const params = [organizationId];
      let where = 'WHERE p.organization_id = $1';
      if (staffId) {
        params.push(staffId);
        where += ` AND p.staff_id = $${params.length}`;
      }
      if (status) {
        params.push(status);
        where += ` AND p.status = $${params.length}`;
      }
      if (payoutType) {
        params.push(payoutType);
        where += ` AND p.payout_type = $${params.length}`;
      }
      const result = await query(
        `SELECT p.*, s.name AS staff_name, a.name AS account_name
           FROM payouts p
           JOIN staff s ON s.id = p.staff_id AND s.organization_id = p.organization_id
           JOIN accounts a ON a.id = p.account_id AND a.organization_id = p.organization_id
          ${where}
          ORDER BY p.payout_date DESC, p.created_at DESC`,
        params
      );
      return NextResponse.json({ success: true, data: result.rows });
    });
  } catch (error) {
    console.error('[Payouts] GET error:', error);
    return NextResponse.json({ success: false, error: 'Failed to fetch payouts' }, { status: 500 });
  }
}

export async function POST(request) {
  const perm = await requirePermission(request, 'finance.manage');
  if (perm instanceof NextResponse) return perm;
  const organizationId = perm.auth.organizationId;

  try {
    const body = await request.json();
    const staffId = body?.staff_id;
    const sourceAccountId = body?.account_id;
    const amountText = typeof body?.amount === 'number'
      ? String(body.amount)
      : String(body?.amount ?? '').trim();
    const amount = Number(amountText);
    const currency = String(body?.currency || 'UGX').toUpperCase();
    const payoutType = body?.payout_type || 'salary';
    const idempotencyKey = request.headers.get('idempotency-key') || '';

    if (typeof staffId !== 'string' || typeof sourceAccountId !== 'string') {
      return NextResponse.json({ success: false, error: 'staff_id and account_id are required' }, { status: 400 });
    }
    if (!/^\d+(?:\.\d{1,2})?$/.test(amountText) || !Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json({ success: false, error: 'Amount must be positive and have no more than two decimal places' }, { status: 400 });
    }
    if (currency !== 'UGX') {
      return NextResponse.json({ success: false, error: 'Staff wallet credits currently support UGX only' }, { status: 400 });
    }
    if (!PAYOUT_TYPES.has(payoutType)) {
      return NextResponse.json({ success: false, error: 'Invalid payout type' }, { status: 400 });
    }
    if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      return NextResponse.json({ success: false, error: 'A valid Idempotency-Key header is required' }, { status: 400 });
    }

    return await runWithOrganizationContext(organizationId, async () => {
      const client = await getPool().connect();
      try {
        await client.query('BEGIN');
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [`${organizationId}:payroll:${idempotencyKey}`]
        );
        const duplicate = await client.query(
          `SELECT id, staff_id, account_id, amount, currency, payout_type, status, ledger_transaction_id
             FROM payouts
            WHERE organization_id = $1 AND idempotency_key = $2`,
          [organizationId, idempotencyKey]
        );
        if (duplicate.rows[0]) {
          const existing = duplicate.rows[0];
          const matches = existing.staff_id === staffId &&
            existing.account_id === sourceAccountId &&
            Number(existing.amount) === amount &&
            existing.currency === currency &&
            existing.payout_type === payoutType;
          await client.query('COMMIT');
          if (!matches) {
            return NextResponse.json({ success: false, error: 'Idempotency key was already used with different payout details' }, { status: 409 });
          }
          return NextResponse.json({ success: true, duplicate: true, data: existing });
        }

        const source = await client.query(
          `SELECT id, type, currency, is_active, status
             FROM accounts
            WHERE id = $1 AND organization_id = $2
            FOR UPDATE`,
          [sourceAccountId, organizationId]
        );
        const account = source.rows[0];
        if (!account) {
          await client.query('ROLLBACK');
          return NextResponse.json({ success: false, error: 'Source account not found' }, { status: 404 });
        }
        if (!['bank', 'cash', 'mobile_money', 'system'].includes(account.type) ||
            account.currency !== currency || account.is_active !== true || account.status !== 'active') {
          await client.query('ROLLBACK');
          return NextResponse.json({ success: false, error: 'Select an active UGX organization cash, bank, mobile-money, or system account' }, { status: 400 });
        }

        const balanceResult = await client.query(
          `SELECT COALESCE(SUM(amount), 0) AS balance
             FROM ledger
            WHERE account_id = $1
              AND organization_id = $2
              AND currency = $3`,
          [sourceAccountId, organizationId, currency]
        );
        const available = Number(balanceResult.rows[0]?.balance || 0);
        if (available < amount) {
          await client.query('ROLLBACK');
          return NextResponse.json({
            success: false,
            error: `Insufficient balance. Available: ${available}, requested: ${amount}`,
          }, { status: 400 });
        }

        const wallet = await ensureEmployeeWallet(client, {
          staffId,
          organizationId,
          currency,
        });
        const transaction = await createTransaction({
          description: body.description || `Payroll credit: ${payoutType}`,
          transaction_type: 'withdrawal',
          reference: body.reference || null,
          userId: perm.auth.userId,
          client,
          entries: [
            {
              account_id: sourceAccountId,
              type: 'DEBIT',
              amount,
              currency,
              description: `Payroll credit to staff wallet ${wallet.id}`,
            },
            {
              employee_account_id: wallet.id,
              type: 'CREDIT',
              amount,
              currency,
              description: body.description || `Staff ${payoutType} credit`,
            },
          ],
        });
        const payout = await client.query(
          `INSERT INTO payouts
             (organization_id, staff_id, employee_account_id, account_id, amount, currency,
              payout_type, status, description, reference, payout_date, notes, created_by,
              ledger_transaction_id, idempotency_key, processed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'completed', $8, $9, $10, $11, $12, $13, $14, NOW())
           RETURNING *`,
          [
            organizationId,
            staffId,
            wallet.id,
            sourceAccountId,
            amount,
            currency,
            payoutType,
            body.description || null,
            body.reference || null,
            body.payout_date || new Date().toISOString().slice(0, 10),
            body.notes || null,
            perm.auth.userId,
            transaction.transaction.id,
            idempotencyKey,
          ]
        );
        await client.query(
          `INSERT INTO audit_logs
             (organization_id, user_id, action, entity_type, entity_id, details)
           VALUES ($1, $2, 'CREATE', 'payroll_credit', $3, $4)`,
          [
            organizationId,
            perm.auth.userId,
            payout.rows[0].id,
            JSON.stringify({
              staff_id: staffId,
              source_account_id: sourceAccountId,
              employee_account_id: wallet.id,
              transaction_id: transaction.transaction.id,
              amount,
              currency,
              payout_type: payoutType,
            }),
          ]
        );
        await client.query('COMMIT');
        return NextResponse.json({
          success: true,
          data: { ...payout.rows[0], ledger_transaction_id: transaction.transaction.id },
          message: 'Funds credited to the staff member’s internal wallet. No external mobile-money or bank payment was sent.',
        }, { status: 201 });
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[Payouts] POST error:', error);
        if (error.code === '23505') {
          return NextResponse.json({ success: false, error: 'This payout request was already recorded.' }, { status: 409 });
        }
        const message = error?.message || '';
        const clientError = /not found|wallet is not active|Insufficient/i.test(message);
        return NextResponse.json({
          success: false,
          error: clientError ? message : 'Payout could not be completed. No ledger entries were posted.',
        }, { status: clientError ? 400 : 500 });
      } finally {
        await client.release();
      }
    });
  } catch (error) {
    console.error('[Payouts] POST error:', error);
    return NextResponse.json({ success: false, error: 'Failed to create payout' }, { status: 500 });
  }
}
