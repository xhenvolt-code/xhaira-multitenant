import { getPool } from '@/lib/db.js';
import { validateWithdrawal } from '@/lib/account-rules-engine.js';
import { getMarzpayDisbursement, isMarzpayConfigured, sendMarzpayMoney } from '@/lib/payments/marzpay.js';
import {
  getMarzpayReconciliationAccount,
  getMarzpaySettlementAccount,
} from '@/lib/payments/settlement-account.js';
import {
  isMarzpayDisbursementComplete,
  postCompletedDisbursementLedger,
  postDisbursementVarianceAdjustment,
} from '@/lib/payments/marzpay-disbursement-ledger.js';

const OPEN_STATUSES = ['created', 'processing', 'review'];

function safeError(value) {
  return String(value || 'Payment provider error').slice(0, 240);
}

function normalizeUgandaPhone(value) {
  let digits = String(value || '').replace(/[\s()-]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  if (/^0[37]\d{8}$/.test(digits)) digits = `256${digits.slice(1)}`;
  else if (/^[37]\d{8}$/.test(digits)) digits = `256${digits}`;
  return /^256[37]\d{8}$/.test(digits) ? `+${digits}` : null;
}

export async function createMobileMoneyDisbursement({ amountUgx, phone, memberAccountId, idempotencyKey, userId, callbackUrl, reason, receiverName }) {
  if (!isMarzpayConfigured()) return { ok: false, status: 503, error: 'MarzPay is not configured' };
  if (!Number.isSafeInteger(amountUgx) || amountUgx <= 0) return { ok: false, status: 400, error: 'Amount must be a positive whole number of UGX' };
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(memberAccountId || ''))) {
    return { ok: false, status: 400, error: 'Select a valid member account' };
  }
  const normalizedPhone = normalizeUgandaPhone(phone);
  if (!normalizedPhone) return { ok: false, status: 400, error: 'Enter a valid Uganda mobile money number' };
  if (!/^[\w:.-]{8,128}$/.test(String(idempotencyKey || ''))) return { ok: false, status: 400, error: 'A valid Idempotency-Key header is required' };
  if (!String(reason || '').trim() || String(reason).trim().length > 1000 ||
      !String(receiverName || '').trim() || String(receiverName).trim().length > 255) {
    return { ok: false, status: 400, error: 'Withdrawal reason and receiver name are required' };
  }

  const pool = getPool();
  const existing = await pool.query(
    `SELECT id, direction, status, amount_minor, settlement_account_id, member_account_id
       FROM payment_intents WHERE idempotency_key = $1 LIMIT 1`,
    [idempotencyKey]
  );
  if (existing.rows[0]) {
    const intent = existing.rows[0];
    if (intent.direction !== 'disbursement' || Number(intent.amount_minor) !== amountUgx || intent.member_account_id !== memberAccountId) {
      return { ok: false, status: 409, error: 'Idempotency key was already used with different transaction details' };
    }
    return { ok: true, duplicate: true, id: intent.id, status: intent.status, amountUgx };
  }

  const settlementAccount = await getMarzpaySettlementAccount();
  if (!settlementAccount) {
    return { ok: false, status: 409, error: 'Configure an active UGX MarzPay settlement account in organization settings before sending money' };
  }
  const schema = await pool.query(
    `SELECT COUNT(*)::int AS column_count
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'payment_intents'
        AND column_name = ANY($1::text[])`,
    [['provider_amount_minor', 'provider_currency', 'provider_mode', 'ledger_amount_minor', 'provider_fee_minor']]
  );
  const ledgerSchema = await pool.query(
    `SELECT COUNT(*)::int AS column_count
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'payment_intents'
        AND column_name = ANY($1::text[])`,
    [['ledger_status', 'reconciliation_status', 'reconciliation_error',
      'reconciliation_checked_at', 'reconciliation_adjustment_transaction_id',
      'ledger_failure_reason', 'provider_fee_confirmed']]
  );
  const directionConstraint = await pool.query(
    `SELECT EXISTS (
       SELECT 1
         FROM pg_constraint
        WHERE conrelid = to_regclass('public.payment_intents')
          AND conname = 'payment_intents_direction_check'
          AND pg_get_constraintdef(oid) LIKE '%disbursement%'
     ) AS supports_disbursements`
  );
  if (schema.rows[0]?.column_count !== 5 || ledgerSchema.rows[0]?.column_count !== 7 ||
      !directionConstraint.rows[0]?.supports_disbursements) {
    return { ok: false, status: 503, error: 'Payment schema is not ready. No MarzPay request was sent; apply migrations 959, 961, 962, 963, and 964, then retry.' };
  }
  const settlementAccountId = settlementAccount.id;
  const accountCheck = await pool.query(
    `SELECT a.id, m.full_name
       FROM accounts a
       JOIN member_accounts ma ON ma.id = $2 AND ma.organization_id = a.organization_id
       JOIN members m ON m.id = ma.member_id AND m.organization_id = ma.organization_id
       WHERE a.id = $1 AND a.organization_id = public.current_organization_id()
         AND ma.organization_id = public.current_organization_id()
         AND a.currency = 'UGX' AND a.is_active = true AND a.status = 'active'
         AND ma.currency = 'UGX' AND ma.status = 'active'`,
    [settlementAccountId, memberAccountId]
  );
  if (!accountCheck.rows[0]) return { ok: false, status: 400, error: 'Select an active UGX member account; verify the organization settlement account in settings' };
  const depositorName = accountCheck.rows[0].full_name;

  const client = await pool.connect();
  let intent;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [memberAccountId]);

    const duplicate = await client.query(
      `SELECT id, direction, status, amount_minor, settlement_account_id, member_account_id
         FROM payment_intents WHERE idempotency_key = $1 LIMIT 1`,
      [idempotencyKey]
    );
    if (duplicate.rows[0]) {
      const existingIntent = duplicate.rows[0];
      await client.query('COMMIT');
      if (existingIntent.direction !== 'disbursement' || Number(existingIntent.amount_minor) !== amountUgx ||
          existingIntent.member_account_id !== memberAccountId) {
        return { ok: false, status: 409, error: 'Idempotency key was already used with different transaction details' };
      }
      return { ok: true, duplicate: true, id: existingIntent.id, status: existingIntent.status, amountUgx };
    }

    const balanceResult = await client.query(
      `SELECT COALESCE(SUM(CASE WHEN entry_type = 'CREDIT' THEN amount ELSE -amount END), 0) AS balance
         FROM ledger_entries WHERE member_account_id = $1`,
      [memberAccountId]
    );
    const reservedResult = await client.query(
      `SELECT COALESCE(SUM(amount_minor), 0)::numeric AS amount
         FROM payment_intents
        WHERE member_account_id = $1 AND direction = 'disbursement'
          AND status = ANY($2::text[])`,
      [memberAccountId, OPEN_STATUSES]
    );
    const available = Number(balanceResult.rows[0]?.balance || 0) - Number(reservedResult.rows[0]?.amount || 0);
    const ruleCheck = await validateWithdrawal(memberAccountId, amountUgx, available);
    if (!ruleCheck.allowed) {
      await client.query('ROLLBACK');
      return { ok: false, status: 422, error: ruleCheck.reason };
    }

    const inserted = await client.query(
      `INSERT INTO payment_intents
         (idempotency_key, direction, amount_minor, settlement_account_id, member_account_id, phone_masked, metadata, created_by)
       VALUES ($1, 'disbursement', $2, $3, $4, $5, $6::jsonb, $7)
       ON CONFLICT (organization_id, idempotency_key) DO NOTHING
       RETURNING id, provider_reference, status`,
      [idempotencyKey, amountUgx, settlementAccountId, memberAccountId,
        `${normalizedPhone.slice(0, 6)}***${normalizedPhone.slice(-3)}`,
        JSON.stringify({ reason: reason.trim(), depositor_name: depositorName, receiver_name: receiverName.trim() }), userId]
    );
    if (!inserted.rows[0]) {
      const conflictingIntent = await client.query(
        `SELECT id, direction, status, amount_minor, settlement_account_id, member_account_id
           FROM payment_intents WHERE idempotency_key = $1 LIMIT 1`,
        [idempotencyKey]
      );
      await client.query('COMMIT');
      const existingIntent = conflictingIntent.rows[0];
      if (!existingIntent || existingIntent.direction !== 'disbursement' || Number(existingIntent.amount_minor) !== amountUgx ||
          existingIntent.member_account_id !== memberAccountId) {
        return { ok: false, status: 409, error: 'Idempotency key was already used with different transaction details' };
      }
      return { ok: true, duplicate: true, id: existingIntent.id, status: existingIntent.status, amountUgx };
    }
    intent = inserted.rows[0];
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.release();
  }
  const started = await sendMarzpayMoney({
    amountUgx,
    phone: normalizedPhone,
    reference: intent.provider_reference,
    description: 'Xhaira SACCO member withdrawal',
    callbackUrl,
    metadata: [{ payment_intent_id: intent.id }],
  });
  if (!started.ok) {
    const state = started.outcomeUnknown ? 'review' : 'failed';
    await pool.query(
      'UPDATE payment_intents SET status = $1, failure_reason = $2, updated_at = NOW() WHERE id = $3 AND status = $4',
      [state, safeError(started.error), intent.id, 'created']
    );
    return { ok: true, id: intent.id, status: state, failureReason: safeError(started.error), amountUgx };
  }

  const providerUuid = started.transaction?.uuid;
  if (!providerUuid) {
    await pool.query(
      "UPDATE payment_intents SET status = 'review', failure_reason = $1, updated_at = NOW() WHERE id = $2 AND status = 'created'",
      ['MarzPay did not return a disbursement identifier; manual reconciliation required', intent.id]
    );
    return { ok: true, id: intent.id, status: 'review', failureReason: 'MarzPay did not return a disbursement identifier; manual reconciliation required', amountUgx };
  }

  await pool.query(
    "UPDATE payment_intents SET provider_uuid = $1, provider_status = $2, status = 'processing', updated_at = NOW() WHERE id = $3 AND status = 'created'",
    [providerUuid, safeError(started.transaction.status), intent.id]
  );
  try {
    const synced = await syncMobileMoneyDisbursement(intent.id);
    return {
      ok: true,
      id: intent.id,
      status: synced.status,
      ledgerStatus: synced.ledgerStatus,
      reconciliationStatus: synced.reconciliationStatus,
      failureReason: synced.error,
      amountUgx,
    };
  } catch (error) {
    console.error('[MarzPay disbursement] Provider accepted payout; ledger posting is retryable:', error.message);
    return {
      ok: true,
      id: intent.id,
      status: 'processing',
      ledgerStatus: 'failed',
      reconciliationStatus: 'pending',
      failureReason: 'MarzPay accepted the payout. Ledger posting failed; recheck this transaction and do not start another withdrawal.',
      amountUgx,
    };
  }
}

export async function createOrganizationMobileMoneyDisbursement({
  amountUgx, phone, organizationAccountId, idempotencyKey, userId, callbackUrl,
  reason, receiverName, organizationTransaction,
}) {
  if (!isMarzpayConfigured()) return { ok: false, status: 503, error: 'MarzPay is not configured' };
  if (!Number.isSafeInteger(amountUgx) || amountUgx <= 0) return { ok: false, status: 400, error: 'Amount must be a positive whole number of UGX' };
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(organizationAccountId || ''))) {
    return { ok: false, status: 400, error: 'Select a valid organization account' };
  }
  const normalizedPhone = normalizeUgandaPhone(phone);
  if (!normalizedPhone) return { ok: false, status: 400, error: 'Enter a valid Uganda mobile money number' };
  if (!/^[\w:.-]{8,128}$/.test(String(idempotencyKey || ''))) return { ok: false, status: 400, error: 'A valid Idempotency-Key header is required' };
  if (!String(reason || '').trim() || String(reason).trim().length > 1000 ||
      !String(receiverName || '').trim() || String(receiverName).trim().length > 255) {
    return { ok: false, status: 400, error: 'Withdrawal reason and recipient name are required' };
  }

  const pool = getPool();
  const settlementAccount = await getMarzpaySettlementAccount();
  if (!settlementAccount) {
    return { ok: false, status: 409, error: 'Configure an active UGX MarzPay settlement account in organization settings before sending money' };
  }
  if (settlementAccount.id !== organizationAccountId) {
    return { ok: false, status: 400, error: 'MarzPay organization withdrawals must use the configured settlement account' };
  }
  const account = await pool.query(
    `SELECT id, name FROM accounts
      WHERE id = $1 AND organization_id = public.current_organization_id()
        AND type = 'mobile_money' AND currency = 'UGX'
        AND is_active IS TRUE AND status = 'active'`,
    [organizationAccountId]
  );
  if (!account.rows[0]) return { ok: false, status: 400, error: 'Selected MarzPay account is not active in this organization' };
  const schema = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'payment_intents'
          AND column_name = 'organization_account_id'
     ) AS supports_organization_accounts`
  );
  if (!schema.rows[0]?.supports_organization_accounts) {
    return { ok: false, status: 503, error: 'Organization MarzPay schema is not ready; apply migration 983_organization_marzpay_transactions.sql' };
  }
  const disbursementSchema = await pool.query(
    `SELECT COUNT(*)::int AS column_count
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'payment_intents'
        AND column_name = ANY($1::text[])`,
    [['ledger_status', 'reconciliation_status', 'reconciliation_error', 'reconciliation_checked_at',
      'reconciliation_adjustment_transaction_id', 'ledger_failure_reason', 'provider_fee_confirmed']]
  );
  const directionConstraint = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conrelid = to_regclass('public.payment_intents')
          AND conname = 'payment_intents_direction_check'
          AND pg_get_constraintdef(oid) LIKE '%disbursement%'
     ) AS supports_disbursements`
  );
  if (disbursementSchema.rows[0]?.column_count !== 7 || !directionConstraint.rows[0]?.supports_disbursements) {
    return { ok: false, status: 503, error: 'MarzPay disbursement schema is not ready; apply migrations 959, 961, 962, 963, 964, and 983 before retrying' };
  }

  const existing = await pool.query(
    `SELECT id, direction, status, amount_minor, organization_account_id, metadata
       FROM payment_intents WHERE idempotency_key = $1 LIMIT 1`,
    [idempotencyKey]
  );
  if (existing.rows[0]) {
    const intent = existing.rows[0];
    if (intent.direction !== 'disbursement' || Number(intent.amount_minor) !== amountUgx ||
        intent.organization_account_id !== organizationAccountId ||
        intent.metadata?.request_fingerprint !== organizationTransaction?.request_fingerprint) {
      return { ok: false, status: 409, error: 'Idempotency key was already used with different transaction details' };
    }
    return { ok: true, duplicate: true, id: intent.id, status: intent.status, amountUgx };
  }

  const client = await pool.connect();
  let intent;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`organization-marzpay:${idempotencyKey}`]);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [organizationAccountId]);
    const lockedAccount = await client.query(
      `SELECT id FROM accounts
        WHERE id = $1 AND organization_id = public.current_organization_id()
          AND type = 'mobile_money' AND currency = 'UGX'
          AND is_active IS TRUE AND status = 'active'
        FOR UPDATE`,
      [organizationAccountId]
    );
    if (!lockedAccount.rows[0]) throw new Error('Selected MarzPay account is not active in this organization');

    const duplicate = await client.query(
      `SELECT id, direction, status, amount_minor, organization_account_id, metadata
         FROM payment_intents WHERE idempotency_key = $1 LIMIT 1`,
      [idempotencyKey]
    );
    if (duplicate.rows[0]) {
      const row = duplicate.rows[0];
      await client.query('COMMIT');
      if (row.direction !== 'disbursement' || Number(row.amount_minor) !== amountUgx ||
          row.organization_account_id !== organizationAccountId ||
          row.metadata?.request_fingerprint !== organizationTransaction?.request_fingerprint) {
        return { ok: false, status: 409, error: 'Idempotency key was already used with different transaction details' };
      }
      return { ok: true, duplicate: true, id: row.id, status: row.status, amountUgx };
    }

    const balance = await client.query(
      `SELECT COALESCE(SUM(amount), 0)::numeric AS amount
         FROM ledger WHERE organization_id = public.current_organization_id()
          AND account_id = $1`,
      [organizationAccountId]
    );
    const reserved = await client.query(
      `SELECT COALESCE(SUM(amount_minor), 0)::numeric AS amount
         FROM payment_intents
        WHERE organization_id = public.current_organization_id()
          AND organization_account_id = $1 AND direction = 'disbursement'
          AND status = ANY($2::text[])`,
      [organizationAccountId, OPEN_STATUSES]
    );
    if (amountUgx > Number(balance.rows[0]?.amount || 0) - Number(reserved.rows[0]?.amount || 0)) {
      await client.query('ROLLBACK');
      return { ok: false, status: 400, error: 'Insufficient organization account balance for this withdrawal' };
    }

    const inserted = await client.query(
      `INSERT INTO payment_intents
         (idempotency_key, direction, amount_minor, settlement_account_id, organization_account_id,
          phone_masked, metadata, created_by)
       VALUES ($1, 'disbursement', $2, $3, $4, $5, $6::jsonb, $7)
       ON CONFLICT (organization_id, idempotency_key) DO NOTHING
       RETURNING id, provider_reference, status`,
      [idempotencyKey, amountUgx, settlementAccount.id, organizationAccountId,
        `${normalizedPhone.slice(0, 6)}***${normalizedPhone.slice(-3)}`,
        JSON.stringify({
          ...organizationTransaction,
          reason: reason.trim(),
          receiver_name: receiverName.trim(),
          transaction_scope: 'organization',
          transaction_type: 'withdrawal',
          account_id: organizationAccountId,
          payment_method: 'mobile_money',
          request_fingerprint: organizationTransaction?.request_fingerprint,
        }), userId]
    );
    if (!inserted.rows[0]) throw new Error('Could not reserve this organization withdrawal; retry with a new idempotency key');
    intent = inserted.rows[0];
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.release();
  }

  const started = await sendMarzpayMoney({
    amountUgx,
    phone: normalizedPhone,
    reference: intent.provider_reference,
    description: reason.trim().slice(0, 255),
    callbackUrl,
    metadata: [{ payment_intent_id: intent.id }, { organization_id: (await pool.query('SELECT public.current_organization_id() AS id')).rows[0].id }],
  });
  if (!started.ok) {
    const state = started.outcomeUnknown ? 'review' : 'failed';
    await pool.query(
      'UPDATE payment_intents SET status = $1, failure_reason = $2, updated_at = NOW() WHERE id = $3 AND status = $4',
      [state, safeError(started.error), intent.id, 'created']
    );
    return { ok: true, id: intent.id, status: state, failureReason: safeError(started.error), amountUgx };
  }
  const providerUuid = started.transaction?.uuid;
  if (!providerUuid) {
    await pool.query(
      "UPDATE payment_intents SET status = 'review', failure_reason = $1, updated_at = NOW() WHERE id = $2 AND status = 'created'",
      ['MarzPay did not return a disbursement identifier; manual reconciliation required', intent.id]
    );
    return { ok: true, id: intent.id, status: 'review', amountUgx };
  }
  await pool.query(
    "UPDATE payment_intents SET provider_uuid = $1, provider_status = $2, status = 'processing', updated_at = NOW() WHERE id = $3 AND status = 'created'",
    [providerUuid, safeError(started.transaction.status), intent.id]
  );
  try {
    const synced = await syncMobileMoneyDisbursement(intent.id);
    return { ok: true, id: intent.id, status: synced.status, ledgerStatus: synced.ledgerStatus,
      reconciliationStatus: synced.reconciliationStatus, failureReason: synced.error, amountUgx };
  } catch (error) {
    console.error('[Organization MarzPay withdrawal] Ledger posting is retryable:', error.message);
    return { ok: true, id: intent.id, status: 'processing', ledgerStatus: 'failed',
      failureReason: 'MarzPay accepted the payout. Ledger posting failed; recheck before starting another withdrawal.', amountUgx };
  }
}

export async function syncMobileMoneyDisbursement(intentId, providerUuidHint = null) {
  const pool = getPool();
  if (providerUuidHint && /^[0-9a-fA-F-]{20,64}$/.test(providerUuidHint)) {
    await pool.query(
      `UPDATE payment_intents
          SET provider_uuid = COALESCE(provider_uuid, $1),
              status = CASE WHEN ledger_status = 'posted' THEN 'settled'
                            WHEN status IN ('review', 'failed') THEN 'processing'
                            ELSE status END,
              updated_at = NOW()
        WHERE id = $2 AND direction = 'disbursement'`,
      [providerUuidHint, intentId]
    );
  }
  const initial = await pool.query(
    `SELECT id, status, provider_uuid, amount_minor, created_by, created_at, failure_reason,
            settlement_account_id, member_account_id, provider_reference, ledger_status,
            reconciliation_status, transaction_id
       FROM payment_intents WHERE id = $1 AND direction = 'disbursement' LIMIT 1`,
    [intentId]
  );
  const row = initial.rows[0];
  if (!row) return { status: 'failed', settled: false, error: 'Disbursement not found' };
  if (row.ledger_status === 'posted' && row.reconciliation_status === 'matched') {
    return {
      status: 'settled',
      ledgerStatus: 'posted',
      reconciliationStatus: 'matched',
      settled: true,
      error: null,
    };
  }
  if (!row.provider_uuid) {
    return {
      status: row.ledger_status === 'posted' ? 'settled' : row.status,
      ledgerStatus: row.ledger_status,
      reconciliationStatus: row.reconciliation_status,
      settled: row.ledger_status === 'posted',
      error: row.failure_reason || null,
    };
  }

  const lookup = await getMarzpayDisbursement(row.provider_uuid);
  if (!lookup.ok || !lookup.transaction) {
    return {
      status: row.ledger_status === 'posted' ? 'settled' : row.status,
      ledgerStatus: row.ledger_status,
      reconciliationStatus: row.reconciliation_status,
      settled: row.ledger_status === 'posted',
      error: safeError(lookup.error),
    };
  }
  const providerTransaction = lookup.transaction;
  const providerStatus = safeError(providerTransaction.status);
  const isComplete = isMarzpayDisbursementComplete(providerTransaction.status);
  const isFailed = ['failed', 'cancelled', 'canceled', 'rejected', 'expired']
    .includes(String(providerTransaction.status || '').trim().toLowerCase());
  const providerAmount = Number.isSafeInteger(providerTransaction.amountMinor)
    ? providerTransaction.amountMinor
    : null;
  const providerFee = Number.isSafeInteger(providerTransaction.feeMinor) && providerTransaction.feeMinor >= 0
    ? providerTransaction.feeMinor
    : null;
  const providerCurrency = typeof providerTransaction.currency === 'string'
    ? providerTransaction.currency.trim().toUpperCase().slice(0, 16)
    : null;
  const providerMode = typeof providerTransaction.mode === 'string'
    ? providerTransaction.mode.trim().toLowerCase().slice(0, 32)
    : null;

  await pool.query(
    `UPDATE payment_intents
        SET provider_status = $1, provider_amount_minor = $2,
            provider_currency = $3, provider_mode = $4, provider_fee_minor = COALESCE($5, 0),
            provider_fee_confirmed = $6,
            status = CASE WHEN ledger_status = 'posted' THEN 'settled'
                          WHEN $7 THEN 'processing'
                          WHEN $8 THEN 'failed'
                          ELSE 'processing' END,
            reconciliation_status = CASE WHEN ledger_status = 'posted'
                                           AND reconciliation_status = 'matched'
                                         THEN 'matched' ELSE 'pending' END,
            reconciliation_error = CASE WHEN ledger_status = 'posted'
                                          AND reconciliation_status = 'matched'
                                        THEN reconciliation_error ELSE NULL END,
            failure_reason = CASE WHEN $8 AND ledger_status <> 'posted'
                                  THEN $9 ELSE failure_reason END,
            updated_at = NOW()
      WHERE id = $10 AND direction = 'disbursement'`,
    [
      providerStatus, providerAmount, providerCurrency, providerMode, providerFee,
      providerFee !== null, isComplete, isFailed,
      providerTransaction.message || `MarzPay reports ${providerStatus}`,
      intentId,
    ]
  );

  if (isComplete) {
    const posting = await postCompletedDisbursementLedger(intentId, providerTransaction, pool);
    const requestedAmount = Number(row.amount_minor);
    const review = async (reason) => {
      await pool.query(
        `UPDATE payment_intents
            SET status = 'settled', ledger_status = 'posted',
                reconciliation_status = 'review', reconciliation_error = $1,
                reconciliation_checked_at = NOW(), updated_at = NOW()
          WHERE id = $2 AND direction = 'disbursement'`,
        [reason, intentId]
      );
      return {
        status: 'settled',
        ledgerStatus: 'posted',
        reconciliationStatus: 'review',
        ledgerAmountMinor: requestedAmount,
        settled: true,
        error: reason,
        duplicate: posting.duplicate,
      };
    };

    if (providerCurrency !== 'UGX') {
      return review('Provider payout currency is missing or is not UGX; requested UGX withdrawal was posted and reconciliation is required.');
    }
    if (providerAmount === null || providerAmount <= 0) {
      return review('Provider payout amount is missing or invalid; requested UGX withdrawal was posted and reconciliation is required.');
    }
    if (providerFee === null || providerFee < 0) {
      return review('Provider payout fee is missing or invalid; requested UGX withdrawal was posted and reconciliation is required.');
    }

    const providerTotal = providerAmount + (providerFee || 0);
    if (!Number.isSafeInteger(providerTotal)) {
      return review('Provider payout amount and fee exceed the supported UGX range; reconciliation is required.');
    }
    const variance = providerTotal - requestedAmount;
    if (providerAmount !== requestedAmount && variance === 0) {
      return review('Provider payout amount differs from the requested member withdrawal; confirm payout and fee treatment before clearing reconciliation.');
    }
    if (variance === 0) {
      await pool.query(
        `UPDATE payment_intents
            SET status = 'settled', ledger_status = 'posted',
                reconciliation_status = 'matched', reconciliation_error = NULL,
                reconciliation_checked_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND direction = 'disbursement'`,
        [intentId]
      );
      return {
        status: 'settled',
        ledgerStatus: 'posted',
        reconciliationStatus: 'matched',
        ledgerAmountMinor: requestedAmount,
        settled: true,
        error: null,
        duplicate: posting.duplicate,
      };
    }

    const reconciliationAccount = await getMarzpayReconciliationAccount();
    if (!reconciliationAccount) {
      return review('Provider amount or fee differs from the requested withdrawal; configure an active UGX reconciliation account before posting the adjustment.');
    }
    try {
      await postDisbursementVarianceAdjustment({
        intentId,
        varianceMinor: variance,
        reconciliationAccountId: reconciliationAccount.id,
        pool,
      });
    } catch (error) {
      console.error('[MarzPay disbursement] Variance adjustment failed:', error.message);
      return review('Withdrawal ledger is posted, but the verified provider variance adjustment failed and must be retried.');
    }
    return {
      status: 'settled',
      ledgerStatus: 'posted',
      reconciliationStatus: 'adjusted',
      ledgerAmountMinor: requestedAmount,
      settled: true,
      error: null,
      duplicate: posting.duplicate,
    };
  }

  if (row.ledger_status === 'posted') {
    await pool.query(
      `UPDATE payment_intents
          SET status = 'settled', reconciliation_status = 'review',
              reconciliation_error = $1, reconciliation_checked_at = NOW(),
              updated_at = NOW()
        WHERE id = $2 AND direction = 'disbursement'`,
      [isFailed
        ? 'Provider no longer reports completion for an already-posted withdrawal; do not reverse automatically.'
        : 'Provider lookup did not confirm completion; the already-posted ledger entry is unchanged.',
      intentId]
    );
    return {
      status: 'settled',
      ledgerStatus: 'posted',
      reconciliationStatus: 'review',
      settled: true,
      error: isFailed ? 'Provider status conflicts with the posted ledger; manual reconciliation is required.' : null,
    };
  }

  if (isFailed) {
    await pool.query(
      `UPDATE payment_intents
          SET status = 'failed', reconciliation_status = 'review',
              reconciliation_error = $1, reconciliation_checked_at = NOW(),
              updated_at = NOW()
        WHERE id = $2 AND direction = 'disbursement' AND ledger_status <> 'posted'`,
      [providerTransaction.message || `MarzPay reports ${providerStatus}`, intentId]
    );
    return { status: 'failed', ledgerStatus: row.ledger_status, reconciliationStatus: 'review', settled: false, error: providerTransaction.message || `MarzPay reports ${providerStatus}` };
  }

  if (Date.now() - new Date(row.created_at).getTime() > 30 * 60 * 1000) {
    await pool.query(
      `UPDATE payment_intents
          SET status = 'expired', reconciliation_status = 'review',
              reconciliation_error = 'Disbursement was not approved before timeout',
              reconciliation_checked_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND direction = 'disbursement' AND ledger_status <> 'posted'`,
      [intentId]
    );
    return { status: 'expired', ledgerStatus: row.ledger_status, reconciliationStatus: 'review', settled: false, error: 'Disbursement was not approved before timeout' };
  }
  await pool.query(
    `UPDATE payment_intents
        SET status = 'processing', reconciliation_status = 'pending',
            reconciliation_error = NULL, updated_at = NOW()
      WHERE id = $1 AND direction = 'disbursement' AND ledger_status <> 'posted'`,
    [intentId]
  );
  return {
    status: 'processing',
    ledgerStatus: row.ledger_status,
    reconciliationStatus: 'pending',
    settled: false,
    error: null,
  };
}
