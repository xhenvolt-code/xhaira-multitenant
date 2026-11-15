import { NextResponse } from 'next/server';
import { getPool, query } from '@/lib/db.js';
import { requirePermission } from '@/lib/permissions.js';

// GET /api/accounts — accounts.view
export async function GET(request) {
  const perm = await requirePermission(request, 'accounts.view');
  if (perm instanceof NextResponse) return perm;
  try {
    // Use the view to get balances computed from ledger (alias account_id → id for frontend compat)
    const result = await query(`SELECT account_id AS id, * FROM v_account_balances ORDER BY balance DESC`);
    return NextResponse.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('[Accounts] GET error:', error);
    return NextResponse.json({ success: false, error: 'Failed to fetch accounts' }, { status: 500 });
  }
}

// POST /api/accounts — accounts.create
export async function POST(request) {
  const perm = await requirePermission(request, 'accounts.create');
  if (perm instanceof NextResponse) return perm;
  try {
    const body = await request.json();
    const { name, type, currency, description, institution, account_number, initial_balance } = body;
    if (typeof name !== 'string' || !name.trim() || !type) return NextResponse.json({ success: false, error: 'Account name and type are required' }, { status: 400 });
    const VALID_TYPES = ['bank','cash','mobile_money','credit_card','investment','escrow','savings','internal','salary','other'];
    if (!VALID_TYPES.includes(type)) {
      return NextResponse.json({ success: false, error: `Invalid account type "${type}". Allowed: ${VALID_TYPES.join(', ')}` }, { status: 400 });
    }
    const openingBalance = initial_balance === undefined || initial_balance === '' ? 0 : Number(initial_balance);
    if (!Number.isFinite(openingBalance)) return NextResponse.json({ success: false, error: 'Initial balance must be a valid number' }, { status: 400 });
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `INSERT INTO accounts (name, type, currency, description, institution, account_number)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [name.trim(), type, String(currency || 'UGX').trim().toUpperCase(), description?.trim() || null, institution?.trim() || null, account_number?.trim() || null]
      );
      const account = result.rows[0];
      if (openingBalance !== 0) {
        await client.query(
          `INSERT INTO ledger (account_id, amount, currency, source_type, description, category, entry_date, created_by)
           VALUES ($1,$2,$3,'initial_balance',$4,'initial_balance',CURRENT_DATE,$5)`,
          [account.id, openingBalance, account.currency, `Initial balance for ${account.name}`, perm.auth.userId]
        );
      }
      await client.query(`INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details) VALUES ($1,$2,$3,$4,$5)`,
        [perm.auth.userId, 'CREATE', 'account', account.id, JSON.stringify({ name: account.name, type })]);
      await client.query('COMMIT');
      return NextResponse.json({ success: true, data: account }, { status: 201 });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      await client.release();
    }
  } catch (error) {
    console.error('[Accounts] POST error:', error.message);
    return NextResponse.json({ success: false, error: error.code === '23503'
      ? 'The selected user or account reference does not belong to your organization.'
      : error.message || 'Failed to create account' }, { status: 500 });
  }
}
