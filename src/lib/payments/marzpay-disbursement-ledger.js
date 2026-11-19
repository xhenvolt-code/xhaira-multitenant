import { getPool } from '../db.js';

const COMPLETED_PROVIDER_STATES = new Set(['completed', 'successful', 'success']);

export function isMarzpayDisbursementComplete(providerStatus) {
  return COMPLETED_PROVIDER_STATES.has(String(providerStatus || '').trim().toLowerCase());
}

export async function postCompletedDisbursementLedger(intentId, providerTransaction, pool = getPool()) {
  if (!isMarzpayDisbursementComplete(providerTransaction?.status)) {
    throw new Error('MarzPay must confirm completion before posting the withdrawal ledger');
  }

  const client = await pool.connect();
  let ledgerFailure = null;
  let result;

  try {
    await client.query('BEGIN');
    const locked = await client.query(
      `SELECT id, direction, status, ledger_status, transaction_id, amount_minor,
              settlement_account_id, member_account_id, provider_reference, provider_uuid,
              created_by
         FROM payment_intents
        WHERE id = $1 AND direction = 'disbursement'
        FOR UPDATE`,
      [intentId]
    );
    const intent = locked.rows[0];
    if (!intent) throw new Error('Disbursement not found');
    if (intent.ledger_status === 'posted' && intent.transaction_id) {
      await client.query('COMMIT');
      result = { ledgerStatus: 'posted', transactionId: intent.transaction_id, duplicate: true };
    } else {
      const amount = Number(intent.amount_minor);
      if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('Requested withdrawal amount is invalid');

      const transaction = await client.query(
        `INSERT INTO transactions (description, transaction_type, reference, metadata, created_by)
         VALUES ($1, 'withdrawal', $2, $3::jsonb, $4)
         RETURNING id`,
        [
          'MarzPay mobile money withdrawal',
          intent.provider_reference,
          JSON.stringify({
            provider: 'marzpay',
            mode: 'automatic',
            direction: 'disbursement',
            provider_uuid: intent.provider_uuid,
            payment_intent_id: intent.id,
            requested_amount_minor: amount,
            provider_amount_minor: providerTransaction.amountMinor ?? null,
            provider_currency: providerTransaction.currency ?? null,
            provider_fee_minor: providerTransaction.feeMinor ?? null,
          }),
          intent.created_by,
        ]
      );
      const transactionId = transaction.rows[0].id;
      await client.query(
        `INSERT INTO ledger_entries
           (transaction_id, member_account_id, entry_type, amount, currency, description)
         VALUES ($1, $2, 'DEBIT', $3, 'UGX', $4)`,
        [transactionId, intent.member_account_id, amount, 'Member mobile money withdrawal']
      );
      await client.query(
        `INSERT INTO ledger_entries
           (transaction_id, account_id, entry_type, amount, currency, description)
         VALUES ($1, $2, 'CREDIT', $3, 'UGX', $4)`,
        [transactionId, intent.settlement_account_id, amount, 'MarzPay disbursement settlement']
      );
      await client.query(
        `INSERT INTO ledger (account_id, amount, currency, source_type, source_id, description, entry_date, created_by)
         VALUES ($1, $2, 'UGX', 'adjustment', $3, $4, CURRENT_DATE, $5)`,
        [intent.settlement_account_id, -amount, transactionId, 'MarzPay disbursement settlement', intent.created_by]
      );
      await client.query(
        `UPDATE payment_intents
            SET status = 'settled', ledger_status = 'posted', ledger_amount_minor = $1,
                transaction_id = $2, ledger_failure_reason = NULL,
                settled_at = COALESCE(settled_at, NOW()), updated_at = NOW()
          WHERE id = $3`,
        [amount, transactionId, intent.id]
      );
      await client.query('COMMIT');
      result = { ledgerStatus: 'posted', transactionId, duplicate: false };
    }
  } catch (error) {
    ledgerFailure = error;
    await client.query('ROLLBACK').catch(() => {});
  } finally {
    client.release();
  }

  if (ledgerFailure) {
    try {
      await pool.query(
        `UPDATE payment_intents
            SET ledger_status = 'failed', ledger_failure_reason = $1, updated_at = NOW()
          WHERE id = $2 AND direction = 'disbursement'
            AND (ledger_status IS DISTINCT FROM 'posted' OR transaction_id IS NULL)`,
        [String(ledgerFailure.message || 'Ledger posting failed').slice(0, 255), intentId]
      );
    } catch (stateError) {
      console.error('[MarzPay disbursement] Could not record ledger posting failure:', stateError.message);
    }
    throw ledgerFailure;
  }

  return result;
}

export async function postDisbursementVarianceAdjustment({
  intentId,
  varianceMinor,
  reconciliationAccountId,
  pool = getPool(),
}) {
  if (!Number.isSafeInteger(varianceMinor) || varianceMinor === 0) {
    throw new TypeError('A non-zero whole-UGX variance is required');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query(
      `SELECT id, direction, ledger_status, transaction_id, reconciliation_adjustment_transaction_id,
              settlement_account_id, provider_reference, provider_uuid, provider_amount_minor,
              provider_fee_minor, amount_minor, created_by, organization_id
         FROM payment_intents
        WHERE id = $1 AND direction = 'disbursement'
        FOR UPDATE`,
      [intentId]
    );
    const intent = locked.rows[0];
    if (!intent || intent.ledger_status !== 'posted' || !intent.transaction_id) {
      throw new Error('The withdrawal ledger must be posted before recording a variance adjustment');
    }
    if (intent.reconciliation_adjustment_transaction_id) {
      await client.query('COMMIT');
      return { adjustmentTransactionId: intent.reconciliation_adjustment_transaction_id, duplicate: true };
    }

    const contra = await client.query(
      `SELECT id
         FROM accounts
        WHERE id = $1 AND organization_id = $2 AND type = 'system'
          AND currency = 'UGX' AND is_active = TRUE AND status = 'active'`,
      [reconciliationAccountId, intent.organization_id]
    );
    if (!contra.rows[0]) throw new Error('A valid organization UGX reconciliation account is required');

    const adjustmentAmount = Math.abs(varianceMinor);
    const settlementEntryType = varianceMinor > 0 ? 'CREDIT' : 'DEBIT';
    const contraEntryType = varianceMinor > 0 ? 'DEBIT' : 'CREDIT';
    const transaction = await client.query(
      `INSERT INTO transactions (description, transaction_type, reference, metadata, created_by)
       VALUES ($1, 'adjustment', $2, $3::jsonb, $4)
       RETURNING id`,
      [
        'MarzPay withdrawal provider variance adjustment',
        `${intent.provider_reference}:reconciliation`,
        JSON.stringify({
          provider: 'marzpay',
          payment_intent_id: intent.id,
          adjustment_type: 'provider_variance',
          requested_amount_minor: Number(intent.amount_minor),
          provider_amount_minor: intent.provider_amount_minor,
          provider_fee_minor: intent.provider_fee_minor,
          variance_minor: varianceMinor,
        }),
        intent.created_by,
      ]
    );
    const transactionId = transaction.rows[0].id;
    await client.query(
      `INSERT INTO ledger_entries
         (transaction_id, account_id, entry_type, amount, currency, description)
       VALUES ($1, $2, $3, $4, 'UGX', $5)`,
      [transactionId, intent.settlement_account_id, settlementEntryType, adjustmentAmount,
        'MarzPay provider payout variance']
    );
    await client.query(
      `INSERT INTO ledger_entries
         (transaction_id, account_id, entry_type, amount, currency, description)
       VALUES ($1, $2, $3, $4, 'UGX', $5)`,
      [transactionId, reconciliationAccountId, contraEntryType, adjustmentAmount,
        'MarzPay provider payout variance contra']
    );
    await client.query(
      `INSERT INTO ledger
         (account_id, amount, currency, source_type, source_id, description, entry_date, created_by)
       VALUES ($1, $2, 'UGX', 'adjustment', $3, $4, CURRENT_DATE, $5),
              ($6, $7, 'UGX', 'adjustment', $3, $8, CURRENT_DATE, $5)`,
      [
        intent.settlement_account_id,
        -varianceMinor,
        transactionId,
        'MarzPay provider payout cash variance',
        intent.created_by,
        reconciliationAccountId,
        varianceMinor,
        'MarzPay provider payout variance contra',
      ]
    );
    await client.query(
      `UPDATE payment_intents
          SET reconciliation_status = 'adjusted', reconciliation_error = NULL,
              reconciliation_adjustment_transaction_id = $1,
              reconciliation_checked_at = NOW(), updated_at = NOW()
        WHERE id = $2`,
      [transactionId, intent.id]
    );
    await client.query('COMMIT');
    return { adjustmentTransactionId: transactionId, duplicate: false };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
