import { NextResponse } from 'next/server';
import { query } from '@/lib/db.js';
import { requirePermission } from '@/lib/permissions.js';
import { createTransaction, deposit, withdraw, getMemberAccountBalance } from '@/lib/transaction-service.js';
import { runWithOrganizationContext } from '@/lib/organization-context.js';

// GET /api/transactions — List transactions with pagination
export async function GET(request) {
  try {
    const perm = await requirePermission(request, 'finance.view');
    if (perm instanceof NextResponse) return perm;
    return await runWithOrganizationContext(perm.auth.organizationId, async () => {

    const { searchParams } = new URL(request.url);
    const type = searchParams.get('type') || '';
    const memberAccountId = searchParams.get('member_account_id') || '';
    const accountId = searchParams.get('account_id') || '';
    const page = Math.max(1, parseInt(searchParams.get('page') || '1'));
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '50')));
    const offset = (page - 1) * limit;

    const organizationId = perm.auth.organizationId;
    let where = 'WHERE t.organization_id = $1';
    const params = [organizationId];

    if (type) {
      params.push(type);
      where += ` AND t.transaction_type = $${params.length}`;
    }

    if (memberAccountId) {
      params.push(memberAccountId);
      where += ` AND t.id IN (
        SELECT le.transaction_id FROM ledger_entries le
         WHERE le.organization_id = $1 AND le.member_account_id = $${params.length}
      )`;
    }

    if (accountId) {
      params.push(accountId);
      where += ` AND (t.id IN (
        SELECT le.transaction_id FROM ledger_entries le
         WHERE le.organization_id = $1 AND le.account_id = $${params.length}
      ) OR t.id IN (
        SELECT l.source_id FROM ledger l
         WHERE l.organization_id = $1 AND l.account_id = $${params.length} AND l.source_id IS NOT NULL
      ))`;
    }

    const countParams = [...params];
    params.push(limit, offset);

    const [dataResult, countResult] = await Promise.all([
      query(
        `SELECT t.*, u.email as created_by_email, u.name as created_by_name,
           COALESCE(json_agg(json_build_object(
             'id', le.id, 'entry_type', le.entry_type, 'amount', le.amount,
             'account_id', le.account_id, 'member_account_id', le.member_account_id,
             'description', le.description
           ) ORDER BY le.entry_type) FILTER (WHERE le.id IS NOT NULL),
           (SELECT json_agg(json_build_object(
              'id', l.id,
              'entry_type', CASE WHEN l.amount < 0 THEN 'DEBIT' ELSE 'CREDIT' END,
              'amount', ABS(l.amount), 'account_id', l.account_id,
              'member_account_id', NULL, 'description', l.description,
              'account_name', a.name, 'currency', l.currency
            )) FROM ledger l JOIN accounts a ON a.id = l.account_id AND a.organization_id = l.organization_id
             WHERE l.organization_id = t.organization_id AND l.source_id = t.id),
           '[]'::json) as entries
         FROM transactions t
         LEFT JOIN users u ON t.created_by = u.id AND u.organization_id = $1
         LEFT JOIN ledger_entries le ON le.transaction_id = t.id AND le.organization_id = $1
         ${where}
         GROUP BY t.id, u.email, u.name
         ORDER BY t.created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      ),
      query(`SELECT COUNT(*) as total FROM transactions t ${where}`, countParams),
    ]);

    return NextResponse.json({
      success: true,
      data: dataResult.rows,
      pagination: {
        page, limit,
        total: parseInt(countResult.rows[0]?.total || 0),
        totalPages: Math.ceil(parseInt(countResult.rows[0]?.total || 0) / limit),
      },
    });
    });
  } catch (error) {
    console.error('[Transactions] GET error:', error.message);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// POST /api/transactions — Create a transaction (deposit, withdrawal, or custom)
export async function POST(request) {
  try {
    const perm = await requirePermission(request, 'finance.manage');
    if (perm instanceof NextResponse) return perm;
    return await runWithOrganizationContext(perm.auth.organizationId, async () => {

    const body = await request.json();
    const { action, member_account_id, account_id, amount, description, reference, entries, transaction_type, metadata, reason, paid_by, withdrawn_to } = body;
    const requestedMemberAccountIds = [...new Set((['deposit', 'withdraw'].includes(action)
      ? [member_account_id]
      : (Array.isArray(entries) ? entries.map((entry) => entry.member_account_id) : [])).filter(Boolean))];
    if (requestedMemberAccountIds.length) {
      const availableAccounts = await query(
        `SELECT COUNT(*)::int AS count
           FROM member_accounts ma JOIN members m ON m.id = ma.member_id AND m.organization_id = ma.organization_id
          WHERE ma.organization_id = $1 AND ma.id = ANY($2::uuid[]) AND m.trashed_at IS NULL`,
        [perm.auth.organizationId, requestedMemberAccountIds]
      );
      if (availableAccounts.rows[0].count !== requestedMemberAccountIds.length) {
        return NextResponse.json({ success: false, error: 'One or more member accounts are unavailable' }, { status: 404 });
      }
    }
    const transactionMetadata = {
      ...(metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}),
      ...(typeof reason === 'string' && reason.trim() ? { reason: reason.trim().slice(0, 1000) } : {}),
      ...(typeof paid_by === 'string' && paid_by.trim() ? { paid_by: paid_by.trim().slice(0, 255) } : {}),
      ...(typeof withdrawn_to === 'string' && withdrawn_to.trim() ? { withdrawn_to: withdrawn_to.trim().slice(0, 255) } : {}),
    };

    if (!amount && !entries) {
      return NextResponse.json({ success: false, error: 'amount or entries required' }, { status: 400 });
    }

    let result;

    // Shorthand actions
    if (action === 'deposit') {
      if (!member_account_id || !amount) {
        return NextResponse.json({ success: false, error: 'member_account_id and amount required for deposit' }, { status: 400 });
      }
      if (typeof reason !== 'string' || !reason.trim()) {
        return NextResponse.json({ success: false, error: 'A reason is required for a deposit' }, { status: 400 });
      }
      if (paid_by != null && typeof paid_by !== 'string') {
        return NextResponse.json({ success: false, error: 'Deposited by must be text when provided' }, { status: 400 });
      }
      result = await deposit({
        memberAccountId: member_account_id,
        amount: parseFloat(amount),
        description,
        reason,
        paidBy: typeof paid_by === 'string' ? paid_by.trim().slice(0, 255) || null : null,
        reference,
        userId: perm.auth.userId,
      });
    } else if (action === 'withdraw') {
      if (!member_account_id || !amount) {
        return NextResponse.json({ success: false, error: 'member_account_id and amount required for withdrawal' }, { status: 400 });
      }
      if (typeof reason !== 'string' || !reason.trim() || typeof withdrawn_to !== 'string' || !withdrawn_to.trim()) {
        return NextResponse.json({ success: false, error: 'Reason and receiver name are required for a withdrawal' }, { status: 400 });
      }
      result = await withdraw({
        memberAccountId: member_account_id,
        amount: parseFloat(amount),
        description,
        reason,
        withdrawnTo: withdrawn_to,
        reference,
        userId: perm.auth.userId,
      });
    } else if (entries) {
      // Custom double-entry transaction
      result = await createTransaction({
        description: description || 'Manual transaction',
        transaction_type: transaction_type || 'adjustment',
        reference,
        metadata: transactionMetadata,
        userId: perm.auth.userId,
        entries: entries.map(e => ({
          ...e,
          amount: parseFloat(e.amount),
        })),
      });
    } else {
      return NextResponse.json({ success: false, error: 'Specify action (deposit/withdraw) or provide entries array' }, { status: 400 });
    }

    const memberAccountIds = [...new Set(
      (action === 'deposit' || action === 'withdraw'
        ? [member_account_id]
        : (entries || []).map((entry) => entry.member_account_id)
      ).filter(Boolean)
    )];
    const balances = Object.fromEntries(await Promise.all(
      memberAccountIds.map(async (memberAccountId) => [
        memberAccountId,
        await getMemberAccountBalance(memberAccountId),
      ])
    ));
    return NextResponse.json({
      success: true,
      data: {
        ...result,
        balances,
        ...(memberAccountIds.length === 1 ? { balance: balances[memberAccountIds[0]] } : {}),
      },
    }, { status: 201 });
    });
  } catch (error) {
    console.error('[Transactions] POST error:', error.message);
    const status = error.code === 'RULE_VIOLATION' ? 422
      : error.message.includes('Insufficient balance') ? 400
      : error.message.includes('not balanced') ? 400
      : error.message.includes('not found') ? 404
      : 500;
    return NextResponse.json({ success: false, error: error.message }, { status });
  }
}
