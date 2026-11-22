/**
 * XHAIRA — Double-Entry Transaction Service
 * 
 * The ONLY way to move money in the system.
 * Every financial action creates a transaction with balanced DEBIT/CREDIT entries.
 * 
 * Rules:
 * - Total DEBITs MUST equal total CREDITs
 * - No negative amounts
 * - All referenced accounts must exist
 * - Transactions are atomic (all or nothing)
 * - Ledger entries are IMMUTABLE (never edit, only reverse)
 */

import { getPool } from '@/lib/db.js';
import { validateWithdrawal } from '@/lib/account-rules-engine.js';
import { getAccountLedgerDelta } from './account-ledger.js';

/**
 * Get the system cash account ID (SACCO liquidity pool)
 */
export async function getSystemAccountId(client) {
  const result = await client.query(
    `SELECT id
       FROM accounts
      WHERE organization_id = public.current_organization_id()
        AND is_primary_cash_account IS TRUE
        AND type = 'system'
        AND currency = 'UGX'
        AND is_active IS TRUE
        AND status = 'active'
      LIMIT 1`
  );
  if (result.rows.length === 0) {
    throw new Error('No active UGX primary cash account is configured for this organization.');
  }
  return result.rows[0].id;
}

/**
 * Create a double-entry transaction.
 * 
 * @param {Object} params
 * @param {string} params.description - Human-readable description
 * @param {string} params.transaction_type - One of: deposit, withdrawal, transfer, loan_disbursement, loan_repayment, fee, interest, adjustment, initial_balance
 * @param {string} [params.reference] - External reference (receipt #, loan ID, etc.)
 * @param {Object} [params.metadata] - Additional JSON metadata
 * @param {string} params.userId - User creating the transaction
 * @param {Array<{member_account_id?: string, employee_account_id?: string, account_id?: string, type: 'DEBIT'|'CREDIT', amount: number, currency?: string, description?: string}>} params.entries
 * @returns {Promise<{transaction: Object, entries: Array}>}
 */
export async function createTransaction({
  description,
  transaction_type,
  reference,
  metadata,
  userId,
  entries,
  client: transactionClient,
}) {
  // Validation
  if (!description) throw new Error('Transaction description is required');
  if (!entries || entries.length < 2) throw new Error('Transaction must have at least 2 entries');
  
  let totalDebits = 0;
  let totalCredits = 0;

  for (const entry of entries) {
    if (!entry.type || !['DEBIT', 'CREDIT'].includes(entry.type)) {
      throw new Error(`Invalid entry type: ${entry.type}. Must be DEBIT or CREDIT`);
    }
    if (!entry.amount || entry.amount <= 0) {
      throw new Error(`Invalid amount: ${entry.amount}. Must be positive`);
    }
    if (!entry.member_account_id && !entry.employee_account_id && !entry.account_id) {
      throw new Error('Each entry must reference a member_account_id, employee_account_id, or account_id');
    }
    if (entry.type === 'DEBIT') totalDebits += entry.amount;
    if (entry.type === 'CREDIT') totalCredits += entry.amount;
  }

  // Double-entry rule: debits MUST equal credits
  if (Math.abs(totalDebits - totalCredits) > 0.001) {
    throw new Error(
      `Transaction not balanced: total DEBITs (${totalDebits}) ≠ total CREDITs (${totalCredits})`
    );
  }

  const pool = getPool();
  const ownsClient = !transactionClient;
  const client = transactionClient || await pool.connect();
  const transactionMetadata = {
    ...(metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}),
    reason: metadata?.reason || description,
  };

  try {
    if (ownsClient) await client.query('BEGIN');

    // Verify all referenced accounts exist
    for (const entry of entries) {
      if (entry.member_account_id) {
        const acct = await client.query(
          `SELECT id, status, currency
             FROM member_accounts
            WHERE id = $1
              AND organization_id = public.current_organization_id()`,
          [entry.member_account_id]
        );
        if (acct.rows.length === 0) throw new Error(`Member account ${entry.member_account_id} not found`);
        if (acct.rows[0].status === 'closed') throw new Error(`Member account ${entry.member_account_id} is closed`);
        if (acct.rows[0].currency !== (entry.currency || 'UGX')) {
          throw new Error(`Currency mismatch for member account ${entry.member_account_id}`);
        }
      }
      if (entry.employee_account_id) {
        const account = await client.query(
          `SELECT id, status, currency
             FROM employee_accounts
            WHERE id = $1
              AND organization_id = public.current_organization_id()`,
          [entry.employee_account_id]
        );
        if (account.rows.length === 0) throw new Error(`Employee account ${entry.employee_account_id} not found`);
        if (account.rows[0].status !== 'active') throw new Error(`Employee account ${entry.employee_account_id} is not active`);
        if (account.rows[0].currency !== (entry.currency || 'UGX')) {
          throw new Error(`Currency mismatch for employee account ${entry.employee_account_id}`);
        }
      }
      if (entry.account_id) {
        const acct = await client.query(
          `SELECT id, is_active, currency
             FROM accounts
            WHERE id = $1
              AND organization_id = public.current_organization_id()`,
          [entry.account_id]
        );
        if (acct.rows.length === 0) throw new Error(`Account ${entry.account_id} not found`);
        if (acct.rows[0].currency !== (entry.currency || 'UGX')) {
          throw new Error(`Currency mismatch for account ${entry.account_id}`);
        }
      }
    }

    // Create the transaction record
    const txResult = await client.query(
      `INSERT INTO transactions (description, transaction_type, reference, metadata, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [description, transaction_type || null, reference || null, JSON.stringify(transactionMetadata), userId]
    );
    const transaction = txResult.rows[0];

    // Insert all ledger entries
    const insertedEntries = [];
    for (const entry of entries) {
      const entryResult = entry.employee_account_id
        ? await client.query(
          `INSERT INTO ledger_entries
             (transaction_id, account_id, member_account_id, employee_account_id, entry_type, amount, currency, description)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING *`,
          [
            transaction.id,
            entry.account_id || null,
            entry.member_account_id || null,
            entry.employee_account_id,
            entry.type,
            entry.amount,
            entry.currency || 'UGX',
            entry.description || description,
          ]
        )
        : await client.query(
          `INSERT INTO ledger_entries
             (transaction_id, account_id, member_account_id, entry_type, amount, currency, description)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING *`,
          [
            transaction.id,
            entry.account_id || null,
            entry.member_account_id || null,
            entry.type,
            entry.amount,
            entry.currency || 'UGX',
            entry.description || description,
          ]
        );
      insertedEntries.push(entryResult.rows[0]);

      // Also write to company ledger table if account_id is set
      // (needed for v_account_balances view compatibility)
      if (entry.account_id) {
        const ledgerAmount = getAccountLedgerDelta(entry.type, entry.amount, transaction_type);
        await client.query(
          `INSERT INTO ledger (account_id, amount, currency, source_type, source_id, description, entry_date, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, CURRENT_DATE, $7)`,
          [
            entry.account_id,
            ledgerAmount,
            entry.currency || 'UGX',
            transaction_type || 'adjustment',
            transaction.id,
            entry.description || description,
            userId,
          ]
        );
      }
    }

    if (ownsClient) await client.query('COMMIT');

    return { transaction, entries: insertedEntries };
  } catch (err) {
    if (ownsClient) await client.query('ROLLBACK');
    throw err;
  } finally {
    if (ownsClient) await client.release();
  }
}

/**
 * Get computed balance for a member account (from ledger_entries)
 */
export async function getMemberAccountBalance(memberAccountId) {
  const pool = getPool();
  const result = await pool.query(
    `SELECT COALESCE(SUM(
       CASE WHEN entry_type = 'CREDIT' THEN amount
            WHEN entry_type = 'DEBIT' THEN -amount
            ELSE 0 END
     ), 0) AS balance
     FROM ledger_entries
     WHERE member_account_id = $1
       AND organization_id = public.current_organization_id()`,
    [memberAccountId]
  );
  return parseFloat(result.rows[0].balance);
}

/**
 * Deposit money into a member account (from SACCO cash)
 */
export async function deposit({ memberAccountId, amount, description, reference, userId, paymentMethod = 'cash', reason, paidBy }) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const systemAccountId = await getSystemAccountId(client);
    client.release();

    return await createTransaction({
      description: description || 'Member deposit',
      transaction_type: 'deposit',
      reference,
      metadata: {
        payment_method: paymentMethod,
        reason: reason || description || 'Member deposit',
        paid_by: paidBy || null,
      },
      userId,
      entries: [
        { member_account_id: memberAccountId, type: 'CREDIT', amount },
        { account_id: systemAccountId, type: 'DEBIT', amount },
      ],
    });
  } catch (err) {
    client.release();
    throw err;
  }
}

/**
 * Withdraw money from a member account (to SACCO cash)
 */
export async function withdraw({ memberAccountId, amount, description, reference, userId, paymentMethod = 'cash', force = false, reason, withdrawnTo }) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [memberAccountId]);

    const [balanceResult, reservedResult] = await Promise.all([
      client.query(
        `SELECT COALESCE(SUM(CASE WHEN entry_type = 'CREDIT' THEN amount ELSE -amount END), 0) AS balance
           FROM ledger_entries WHERE member_account_id = $1`,
        [memberAccountId]
      ),
      client.query(
        `SELECT COALESCE(SUM(amount_minor), 0)::numeric AS amount
           FROM payment_intents
          WHERE member_account_id = $1 AND direction = 'disbursement'
            AND status = ANY($2::text[])`,
        [memberAccountId, ['created', 'processing', 'review']]
      ),
    ]);
    const balance = Number(balanceResult.rows[0]?.balance || 0);
    const reserved = Number(reservedResult.rows[0]?.amount || 0);
    const available = balance - reserved;
    if (available < amount) {
      throw new Error(`Insufficient balance after pending withdrawals. Available: ${available}, Requested: ${amount}`);
    }
    if (!force) {
      const validation = await validateWithdrawal(memberAccountId, amount, available);
      if (!validation.allowed) {
        const error = new Error(validation.reason);
        error.code = 'RULE_VIOLATION';
        throw error;
      }
    }

    const systemAccountId = await getSystemAccountId(client);
    const result = await createTransaction({
      description: description || 'Member withdrawal',
      transaction_type: 'withdrawal',
      reference,
      metadata: {
        payment_method: paymentMethod,
        reason: reason || description || 'Member withdrawal',
        withdrawn_to: withdrawnTo || null,
      },
      userId,
      entries: [
        { member_account_id: memberAccountId, type: 'DEBIT', amount },
        { account_id: systemAccountId, type: 'CREDIT', amount },
      ],
    });
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.release();
  }
}

/**
 * Transfer money between member accounts (member-to-member or own accounts).
 * DEBIT → Sender account
 * CREDIT → Receiver account
 * No system account involved — pure peer-to-peer.
 */
export async function transfer({
  senderAccountId,
  receiverAccountId,
  amount,
  description,
  reference,
  userId,
}) {
  if (senderAccountId === receiverAccountId) {
    throw new Error('Cannot transfer to the same account');
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Transfer amount must be positive');
  }

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [senderAccountId]
    );

    const accounts = await client.query(
      `SELECT id, member_id, status, currency
         FROM member_accounts
        WHERE id = ANY($1::uuid[])
          AND organization_id = public.current_organization_id()
        ORDER BY id
        FOR UPDATE`,
      [[senderAccountId, receiverAccountId]]
    );
    const sender = accounts.rows.find((account) => account.id === senderAccountId);
    const receiver = accounts.rows.find((account) => account.id === receiverAccountId);
    if (!sender) throw new Error(`Member account ${senderAccountId} not found`);
    if (!receiver) throw new Error(`Member account ${receiverAccountId} not found`);
    if (sender.status !== 'active' || receiver.status !== 'active') {
      throw new Error('Both member accounts must be active');
    }
    if (receiver.currency !== sender.currency) {
      throw new Error('Transfers require both accounts to use the same currency');
    }

    const balanceResult = await client.query(
      `SELECT COALESCE(SUM(
                CASE WHEN entry_type = 'CREDIT' THEN amount
                     WHEN entry_type = 'DEBIT' THEN -amount
                     ELSE 0 END
              ), 0) AS balance
         FROM ledger_entries
        WHERE member_account_id = $1
          AND organization_id = public.current_organization_id()`,
      [senderAccountId]
    );
    const senderBalance = Number(balanceResult.rows[0]?.balance || 0);
    if (senderBalance < amount) {
      throw new Error(`Insufficient balance. Available: ${senderBalance}, Requested: ${amount}`);
    }

    const result = await createTransaction({
      description: description || 'Member-to-member transfer',
      transaction_type: 'transfer',
      reference,
      userId,
      client,
      entries: [
        { member_account_id: senderAccountId, type: 'DEBIT', amount, description: 'Transfer sent' },
        { member_account_id: receiverAccountId, type: 'CREDIT', amount, description: 'Transfer received' },
      ],
    });

    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.release();
  }
}
