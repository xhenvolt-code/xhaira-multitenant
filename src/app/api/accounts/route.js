import { NextResponse } from 'next/server';
import { getPool, query } from '@/lib/db.js';
import { requirePermission } from '@/lib/permissions.js';
import { runWithOrganizationContext } from '@/lib/organization-context.js';

const ACCOUNT_TYPES = new Set([
  'bank', 'cash', 'mobile_money', 'credit_card', 'investment',
  'escrow', 'savings', 'internal', 'salary', 'system', 'other',
]);

// GET /api/accounts — accounts.view
export async function GET(request) {
  const perm = await requirePermission(request, 'accounts.view');
  if (perm instanceof NextResponse) return perm;
  const organizationId = perm.auth.organizationId;
  try {
    return await runWithOrganizationContext(organizationId, async () => {
      const result = await query(
        `SELECT a.id, a.organization_id, a.name, a.type, a.currency, a.description,
                a.institution, a.account_number, a.is_active, a.status,
                a.is_primary_cash_account, a.created_at, a.updated_at,
                COALESCE(v.balance, 0) AS balance,
                COALESCE(v.transaction_count, 0) AS transaction_count,
                v.last_transaction_date
           FROM accounts a
           LEFT JOIN v_account_balances v ON v.account_id = a.id
          WHERE a.organization_id = $1
             AND NOT EXISTS (
               SELECT 1
                 FROM employee_accounts ea
                WHERE ea.account_id = a.id
                  AND ea.organization_id = a.organization_id
             )
           ORDER BY balance DESC, a.created_at ASC, a.id ASC`,
        [organizationId]
      );
      return NextResponse.json({ success: true, data: result.rows });
    });
  } catch (error) {
    console.error('[Accounts] GET error:', error);
    return NextResponse.json({ success: false, error: 'Failed to fetch accounts' }, { status: 500 });
  }
}

// POST /api/accounts — accounts.create
export async function POST(request) {
  const perm = await requirePermission(request, 'accounts.create');
  if (perm instanceof NextResponse) return perm;
  const organizationId = perm.auth.organizationId;

  try {
    return await runWithOrganizationContext(organizationId, async () => {
      const body = await request.json();
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return NextResponse.json({ success: false, error: 'Account details must be a JSON object.' }, { status: 400 });
      }
      const { name, type, currency, description, institution, account_number, initial_balance } = body;
      if (typeof name !== 'string' || !name.trim() || name.trim().length > 255 || typeof type !== 'string') {
        return NextResponse.json({ success: false, error: 'Account name and type are required.' }, { status: 400 });
      }
      if (!ACCOUNT_TYPES.has(type)) {
        return NextResponse.json({ success: false, error: 'Invalid account type.' }, { status: 400 });
      }
      const normalizedCurrency = String(currency || 'UGX').trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(normalizedCurrency)) {
        return NextResponse.json({ success: false, error: 'Currency must be a three-letter code.' }, { status: 400 });
      }
      const openingBalance = initial_balance === undefined || initial_balance === '' ? 0 : Number(initial_balance);
      if (!Number.isFinite(openingBalance)) {
        return NextResponse.json({ success: false, error: 'Initial balance must be a valid number.' }, { status: 400 });
      }

      const pool = getPool();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [organizationId]);
        const accountCountResult = await client.query(
          `SELECT COUNT(*) AS count
             FROM accounts
            WHERE organization_id = $1`,
          [organizationId]
        );
        const isFirstAccount = Number(accountCountResult.rows[0].count) === 0;
        if (isFirstAccount && normalizedCurrency !== 'UGX') {
          await client.query('ROLLBACK');
          return NextResponse.json({
            success: false,
            error: 'The first account must use UGX because it becomes the primary account for deposits and withdrawals.',
          }, { status: 400 });
        }

        const accountType = isFirstAccount ? 'system' : type;
        const accountResult = await client.query(
          `INSERT INTO accounts
             (organization_id, name, type, currency, description, institution, account_number,
              is_primary_cash_account)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING *`,
          [
            organizationId,
            name.trim(),
            accountType,
            normalizedCurrency,
            typeof description === 'string' ? description.trim() || null : null,
            typeof institution === 'string' ? institution.trim() || null : null,
            typeof account_number === 'string' ? account_number.trim() || null : null,
            isFirstAccount,
          ]
        );
        const account = accountResult.rows[0];

        if (openingBalance !== 0) {
          await client.query(
            `INSERT INTO ledger
               (organization_id, account_id, amount, currency, source_type, description,
                category, entry_date, created_by)
             VALUES ($1, $2, $3, $4, 'initial_balance', $5, 'initial_balance', CURRENT_DATE, $6)`,
            [
              organizationId,
              account.id,
              openingBalance,
              account.currency,
              `Initial balance for ${account.name}`,
              perm.auth.userId,
            ]
          );
        }

        await client.query(
          `INSERT INTO audit_logs
             (organization_id, user_id, action, entity_type, entity_id, details)
           VALUES ($1, $2, 'CREATE', 'account', $3, $4)`,
          [
            organizationId,
            perm.auth.userId,
            account.id,
            JSON.stringify({
              name: account.name,
              type: account.type,
              is_primary_cash_account: account.is_primary_cash_account,
            }),
          ]
        );
        await client.query('COMMIT');
        return NextResponse.json({ success: true, data: account }, { status: 201 });
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[Accounts] POST database error:', error);
        if (error.code === '23505') {
          return NextResponse.json({ success: false, error: 'An active system account with this name already exists in your organization.' }, { status: 409 });
        }
        return NextResponse.json({ success: false, error: 'Failed to create account.' }, { status: 500 });
      } finally {
        await client.release();
      }
    });
  } catch (error) {
    console.error('[Accounts] POST error:', error);
    return NextResponse.json({ success: false, error: 'Failed to create account.' }, { status: 500 });
  }
}
