import { NextResponse } from 'next/server';
import { getPool, query } from '@/lib/db.js';
import { requirePermission } from '@/lib/permissions.js';
import { runWithOrganizationContext } from '@/lib/organization-context.js';

const ACCOUNT_TYPES = new Set([
  'bank', 'cash', 'mobile_money', 'credit_card', 'investment',
  'escrow', 'savings', 'internal', 'salary', 'system', 'other',
]);
const ACCOUNT_STATUSES = new Set(['active', 'suspended', 'closed', 'pending']);
const EDITABLE_COLUMNS = {
  name: 'name',
  type: 'type',
  currency: 'currency',
  description: 'description',
  institution: 'institution',
  account_number: 'account_number',
  is_active: 'is_active',
  status: 'status',
};
const AUDIT_FIELDS = Object.keys(EDITABLE_COLUMNS).concat('is_primary_cash_account');

function accountSnapshot(account) {
  return Object.fromEntries(AUDIT_FIELDS.map((field) => [field, account[field]]));
}

function errorResponse(error, operation) {
  console.error(`[Accounts] ${operation} error:`, error);
  if (error.status) {
    return NextResponse.json({ success: false, error: error.message }, { status: error.status });
  }
  if (error.code === '23505') {
    return NextResponse.json({ success: false, error: 'An active system account with this name already exists in your organization.' }, { status: 409 });
  }
  if (error.code === '23514') {
    return NextResponse.json({ success: false, error: 'The account settings do not satisfy the account requirements.' }, { status: 400 });
  }
  return NextResponse.json({ success: false, error: `Failed to ${operation.toLowerCase()} account` }, { status: 500 });
}

function validationError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeUpdates(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw validationError('Account updates must be a JSON object.');
  }
  const allowedFields = new Set([...Object.keys(EDITABLE_COLUMNS), 'is_primary_cash_account']);
  const unknownFields = Object.keys(body).filter((field) => !allowedFields.has(field));
  if (unknownFields.length > 0) {
    throw validationError(`Unsupported account field: ${unknownFields[0]}`);
  }

  const updates = {};
  for (const [field, value] of Object.entries(body)) {
    if (field === 'is_primary_cash_account') {
      if (typeof value !== 'boolean') throw validationError('Primary cash account setting must be true or false.');
      updates[field] = value;
      continue;
    }

    switch (field) {
      case 'name':
        if (typeof value !== 'string' || !value.trim() || value.trim().length > 255) {
          throw validationError('Account name must contain 1 to 255 characters.');
        }
        updates[field] = value.trim();
        break;
      case 'type':
        if (typeof value !== 'string' || !ACCOUNT_TYPES.has(value)) {
          throw validationError('Invalid account type.');
        }
        updates[field] = value;
        break;
      case 'currency': {
        if (typeof value !== 'string' || !/^[A-Za-z]{3}$/.test(value.trim())) {
          throw validationError('Currency must be a three-letter code.');
        }
        updates[field] = value.trim().toUpperCase();
        break;
      }
      case 'description':
      case 'institution':
      case 'account_number':
        if (value !== null && typeof value !== 'string') {
          throw validationError(`${field.replace(/_/g, ' ')} must be text.`);
        }
        if (typeof value === 'string' && value.length > (field === 'description' ? 5000 : 255)) {
          throw validationError(`${field.replace(/_/g, ' ')} is too long.`);
        }
        updates[field] = typeof value === 'string' ? value.trim() || null : null;
        break;
      case 'is_active':
        if (typeof value !== 'boolean') throw validationError('Account active setting must be true or false.');
        updates[field] = value;
        break;
      case 'status':
        if (typeof value !== 'string' || !ACCOUNT_STATUSES.has(value)) {
          throw validationError('Invalid account status.');
        }
        updates[field] = value;
        break;
      default:
        break;
    }
  }

  if (Object.keys(updates).length === 0) {
    throw validationError('No account fields were provided.');
  }
  return updates;
}

async function writeAudit(client, organizationId, userId, accountId, action, before, after) {
  await client.query(
    `INSERT INTO audit_logs
       (organization_id, user_id, action, entity_type, entity_id, details)
     VALUES ($1, $2, $3, 'account', $4, $5)`,
    [organizationId, userId, action, accountId, JSON.stringify({ before, after })]
  );
}

export async function GET(request, { params }) {
  const perm = await requirePermission(request, 'accounts.view');
  if (perm instanceof NextResponse) return perm;
  const organizationId = perm.auth.organizationId;

  try {
    return await runWithOrganizationContext(organizationId, async () => {
      const { id } = await params;
      const result = await query(
        `SELECT a.id, a.organization_id, a.name, a.type, a.currency, a.description,
                a.institution, a.account_number, a.is_active, a.status,
                a.is_primary_cash_account, a.created_at, a.updated_at,
                COALESCE(v.balance, 0) AS balance,
                COALESCE(v.transaction_count, 0) AS transaction_count,
                v.last_transaction_date
           FROM accounts a
           LEFT JOIN v_account_balances v ON v.account_id = a.id
           WHERE a.id = $1
             AND a.organization_id = $2
             AND NOT EXISTS (
               SELECT 1
                 FROM employee_accounts ea
                WHERE ea.account_id = a.id
                  AND ea.organization_id = a.organization_id
             )`,
        [id, organizationId]
      );
      if (!result.rows[0]) {
        return NextResponse.json({ success: false, error: 'Account not found' }, { status: 404 });
      }

      const transactions = await query(
        `SELECT * FROM ledger
          WHERE account_id = $1 AND organization_id = $2
          ORDER BY entry_date DESC, created_at DESC
          LIMIT 50`,
        [id, organizationId]
      );
      return NextResponse.json({
        success: true,
        data: { ...result.rows[0], transactions: transactions.rows },
      });
    });
  } catch (error) {
    return errorResponse(error, 'fetch');
  }
}

async function updateAccount(body, params, organizationId, userId) {
  const { id } = await params;
  const updates = normalizeUpdates(body);
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [organizationId]);

    const currentResult = await client.query(
      `SELECT * FROM accounts
        WHERE id = $1 AND organization_id = $2
        FOR UPDATE`,
      [id, organizationId]
    );
    const current = currentResult.rows[0];
    if (!current) {
      await client.query('ROLLBACK');
      return NextResponse.json({ success: false, error: 'Account not found' }, { status: 404 });
    }
    const employeeWallet = await client.query(
      `SELECT 1 FROM employee_accounts
        WHERE account_id = $1 AND organization_id = $2
        LIMIT 1`,
      [id, organizationId]
    );
    if (employeeWallet.rows[0]) {
      await client.query('ROLLBACK');
      return NextResponse.json({ success: false, error: 'Manage this account from the Employee Accounts section.' }, { status: 409 });
    }

    const next = { ...current, ...updates };
    const nextIsPrimary = updates.is_primary_cash_account ?? current.is_primary_cash_account;
    if (nextIsPrimary && (
      next.type !== 'system' ||
      next.currency !== 'UGX' ||
      next.is_active !== true ||
      next.status !== 'active'
    )) {
      throw validationError('A primary cash account must be an active UGX system account.');
    }
    if (current.is_primary_cash_account && !nextIsPrimary) {
      throw validationError('Assign another primary cash account before removing this designation.', 409);
    }

    const previousPrimaryResult = nextIsPrimary
      ? await client.query(
        `SELECT * FROM accounts
          WHERE organization_id = $1 AND is_primary_cash_account IS TRUE
          FOR UPDATE`,
        [organizationId]
      )
      : { rows: [] };
    const previousPrimary = previousPrimaryResult.rows.find((account) => account.id !== id);
    if (previousPrimary) {
      await client.query(
        `UPDATE accounts
            SET is_primary_cash_account = FALSE, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND organization_id = $2`,
        [previousPrimary.id, organizationId]
      );
      await writeAudit(
        client,
        organizationId,
        userId,
        previousPrimary.id,
        'UPDATE',
        accountSnapshot(previousPrimary),
        { ...accountSnapshot(previousPrimary), is_primary_cash_account: false }
      );
    }

    const assignments = [];
    const values = [];
    for (const [field, value] of Object.entries(updates)) {
      const column = field === 'is_primary_cash_account'
        ? 'is_primary_cash_account'
        : EDITABLE_COLUMNS[field];
      if (!column) continue;
      values.push(value);
      assignments.push(`${column} = $${values.length}`);
    }
    if (assignments.length === 0) {
      throw validationError('No account fields were provided.');
    }
    assignments.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id, organizationId);

    const result = await client.query(
      `UPDATE accounts
          SET ${assignments.join(', ')}
        WHERE id = $${values.length - 1}
          AND organization_id = $${values.length}
        RETURNING *`,
      values
    );
    const updated = result.rows[0];
    await writeAudit(
      client,
      organizationId,
      userId,
      id,
      'UPDATE',
      accountSnapshot(current),
      accountSnapshot(updated)
    );
    await client.query('COMMIT');
    return NextResponse.json({ success: true, data: updated });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.release();
  }
}

export async function PUT(request, { params }) {
  const perm = await requirePermission(request, 'accounts.update');
  if (perm instanceof NextResponse) return perm;
  try {
    return await runWithOrganizationContext(
      perm.auth.organizationId,
      async () => updateAccount(
        await request.json(),
        params,
        perm.auth.organizationId,
        perm.auth.userId
      )
    );
  } catch (error) {
    return errorResponse(error, 'update');
  }
}

export async function PATCH(request, { params }) {
  const perm = await requirePermission(request, 'accounts.update');
  if (perm instanceof NextResponse) return perm;
  try {
    return await runWithOrganizationContext(perm.auth.organizationId, async () => {
      const body = await request.json();
      if (body.action !== 'suspend' && body.action !== 'activate') {
        return updateAccount(
          body,
          params,
          perm.auth.organizationId,
          perm.auth.userId
        );
      }
      if (Object.keys(body).some((key) => key !== 'action')) {
        return NextResponse.json({ success: false, error: 'Do not combine account actions with field updates.' }, { status: 400 });
      }

      const pool = getPool();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [perm.auth.organizationId]);
        const currentResult = await client.query(
          `SELECT * FROM accounts
            WHERE id = $1 AND organization_id = $2
            FOR UPDATE`,
          [(await params).id, perm.auth.organizationId]
        );
        const current = currentResult.rows[0];
        if (!current) {
          await client.query('ROLLBACK');
          return NextResponse.json({ success: false, error: 'Account not found' }, { status: 404 });
        }
        const employeeWallet = await client.query(
          `SELECT 1 FROM employee_accounts
            WHERE account_id = $1 AND organization_id = $2
            LIMIT 1`,
          [current.id, perm.auth.organizationId]
        );
        if (employeeWallet.rows[0]) {
          await client.query('ROLLBACK');
          return NextResponse.json({ success: false, error: 'Manage this account from the Employee Accounts section.' }, { status: 409 });
        }
        if (current.is_primary_cash_account && body.action === 'suspend') {
          await client.query('ROLLBACK');
          return NextResponse.json({ success: false, error: 'Assign another primary cash account before suspending this account.' }, { status: 409 });
        }

        const nextStatus = body.action === 'suspend' ? 'suspended' : 'active';
        const nextIsActive = body.action === 'activate' ? true : current.is_active;
        const result = await client.query(
          `UPDATE accounts
              SET status = $1, is_active = $2, updated_at = CURRENT_TIMESTAMP
            WHERE id = $3 AND organization_id = $4
            RETURNING *`,
          [nextStatus, nextIsActive, current.id, perm.auth.organizationId]
        );
        await writeAudit(
          client,
          perm.auth.organizationId,
          perm.auth.userId,
          current.id,
          'UPDATE',
          accountSnapshot(current),
          accountSnapshot(result.rows[0])
        );
        await client.query('COMMIT');
        return NextResponse.json({ success: true, data: result.rows[0] });
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        await client.release();
      }
    });
  } catch (error) {
    return errorResponse(error, 'update');
  }
}

export async function DELETE(request, { params }) {
  const perm = await requirePermission(request, 'accounts.delete');
  if (perm instanceof NextResponse) return perm;
  const organizationId = perm.auth.organizationId;

  try {
    return await runWithOrganizationContext(organizationId, async () => {
      const { id } = await params;
      const pool = getPool();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [organizationId]);
        const currentResult = await client.query(
          `SELECT * FROM accounts
            WHERE id = $1 AND organization_id = $2
            FOR UPDATE`,
          [id, organizationId]
        );
        const current = currentResult.rows[0];
        if (!current) {
          await client.query('ROLLBACK');
          return NextResponse.json({ success: false, error: 'Account not found' }, { status: 404 });
        }
        const employeeWallet = await client.query(
          `SELECT 1 FROM employee_accounts
            WHERE account_id = $1 AND organization_id = $2
            LIMIT 1`,
          [id, organizationId]
        );
        if (employeeWallet.rows[0]) {
          await client.query('ROLLBACK');
          return NextResponse.json({ success: false, error: 'Staff wallets cannot be closed from account management.' }, { status: 409 });
        }
        if (current.is_primary_cash_account) {
          await client.query('ROLLBACK');
          return NextResponse.json({ success: false, error: 'Assign another primary cash account before closing this account.' }, { status: 409 });
        }

        const dependencies = await client.query(
          `SELECT COUNT(*) AS count
             FROM salary_accounts
            WHERE account_id = $1 AND organization_id = $2`,
          [id, organizationId]
        );
        if (Number(dependencies.rows[0].count) > 0) {
          await client.query('ROLLBACK');
          return NextResponse.json({ success: false, error: 'Cannot close an account with linked salary accounts.' }, { status: 409 });
        }

        const result = await client.query(
          `UPDATE accounts
              SET status = 'closed', is_active = FALSE, updated_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND organization_id = $2
            RETURNING *`,
          [id, organizationId]
        );
        await writeAudit(
          client,
          organizationId,
          perm.auth.userId,
          id,
          'CLOSE',
          accountSnapshot(current),
          accountSnapshot(result.rows[0])
        );
        await client.query('COMMIT');
        return NextResponse.json({ success: true, data: result.rows[0] });
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        await client.release();
      }
    });
  } catch (error) {
    return errorResponse(error, 'close');
  }
}
