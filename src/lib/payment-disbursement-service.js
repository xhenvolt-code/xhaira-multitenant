import { getPool } from '@/lib/db.js';
import { validateWithdrawal } from '@/lib/account-rules-engine.js';
import { getMarzpayDisbursement, isMarzpayConfigured, judgeMarzpayCollection, sendMarzpayMoney } from '@/lib/payments/marzpay.js';
import { getMarzpaySettlementAccount } from '@/lib/payments/settlement-account.js';

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

export async function createMobileMoneyDisbursement({ amountUgx, phone, memberAccountId, idempotencyKey, userId, callbackUrl }) {
  if (!isMarzpayConfigured()) return { ok: false, status: 503, error: 'MarzPay is not configured' };
  if (!Number.isSafeInteger(amountUgx) || amountUgx <= 0) return { ok: false, status: 400, error: 'Amount must be a positive whole number of UGX' };
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(memberAccountId || ''))) {
    return { ok: false, status: 400, error: 'Select a valid member account' };
  }
  const normalizedPhone = normalizeUgandaPhone(phone);
  if (!normalizedPhone) return { ok: false, status: 400, error: 'Enter a valid Uganda mobile money number' };
  if (!/^[\w:.-]{8,128}$/.test(String(idempotencyKey || ''))) return { ok: false, status: 400, error: 'A valid Idempotency-Key header is required' };

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
  const directionConstraint = await pool.query(
    `SELECT EXISTS (
       SELECT 1
         FROM pg_constraint
        WHERE conrelid = to_regclass('public.payment_intents')
          AND conname = 'payment_intents_direction_check'
          AND pg_get_constraintdef(oid) LIKE '%disbursement%'
     ) AS supports_disbursements`
  );
  if (schema.rows[0]?.column_count !== 5 || !directionConstraint.rows[0]?.supports_disbursements) {
    return { ok: false, status: 503, error: 'Payment schema is not ready. No MarzPay request was sent; apply migrations 959, 961, 962, and 963, then retry.' };
  }
  const settlementAccountId = settlementAccount.id;
  const accountCheck = await pool.query(
    `SELECT a.id
       FROM accounts a
       JOIN member_accounts ma ON ma.id = $2 AND ma.organization_id = a.organization_id
       WHERE a.id = $1 AND a.organization_id = public.current_organization_id()
         AND ma.organization_id = public.current_organization_id()
         AND a.currency = 'UGX' AND a.is_active = true AND a.status = 'active'
         AND ma.currency = 'UGX' AND ma.status = 'active'`,
    [settlementAccountId, memberAccountId]
  );
  if (!accountCheck.rows[0]) return { ok: false, status: 400, error: 'Select an active UGX member account; verify the organization settlement account in settings' };

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
         (idempotency_key, direction, amount_minor, settlement_account_id, member_account_id, phone_masked, created_by)
       VALUES ($1, 'disbursement', $2, $3, $4, $5, $6)
       ON CONFLICT (organization_id, idempotency_key) DO NOTHING
       RETURNING id, provider_reference, status`,
      [idempotencyKey, amountUgx, settlementAccountId, memberAccountId, `${normalizedPhone.slice(0, 6)}***${normalizedPhone.slice(-3)}`, userId]
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
  const synced = await syncMobileMoneyDisbursement(intent.id);
  return { ok: true, id: intent.id, status: synced.status, amountUgx };
}

export async function syncMobileMoneyDisbursement(intentId, providerUuidHint = null) {
  const pool = getPool();
  if (providerUuidHint && /^[0-9a-fA-F-]{20,64}$/.test(providerUuidHint)) {
    await pool.query(
      "UPDATE payment_intents SET provider_uuid = COALESCE(provider_uuid, $1), status = CASE WHEN status = 'review' AND provider_uuid IS NULL THEN 'processing' ELSE status END, updated_at = NOW() WHERE id = $2 AND direction = 'disbursement' AND status = ANY($3::text[])",
      [providerUuidHint, intentId, OPEN_STATUSES]
    );
  }
  const initial = await pool.query(
    `SELECT id, status, provider_uuid, amount_minor, created_by, created_at, failure_reason,
            settlement_account_id, member_account_id, provider_reference
       FROM payment_intents WHERE id = $1 AND direction = 'disbursement' LIMIT 1`,
    [intentId]
  );
  const row = initial.rows[0];
  if (!row) return { status: 'failed', settled: false, error: 'Disbursement not found' };
  if (row.status === 'settled' || row.status === 'failed' || row.status === 'expired') {
    return { status: row.status, settled: row.status === 'settled', error: null };
  }
  if (!row.provider_uuid) return { status: row.status, settled: false, error: row.failure_reason || null };

  const lookup = await getMarzpayDisbursement(row.provider_uuid);
  if (!lookup.ok || !lookup.transaction) return { status: row.status, settled: false, error: safeError(lookup.error) };
  const verdict = judgeMarzpayCollection(lookup.transaction, Number(row.amount_minor));
  if (verdict.state === 'processing') {
    if (Date.now() - new Date(row.created_at).getTime() > 30 * 60 * 1000) {
      await pool.query("UPDATE payment_intents SET status = 'expired', provider_status = $1, failure_reason = 'Disbursement was not approved before timeout', updated_at = NOW() WHERE id = $2 AND direction = 'disbursement' AND status = ANY($3::text[])", [safeError(lookup.transaction.status), intentId, OPEN_STATUSES]);
      return { status: 'expired', settled: false, error: 'Disbursement was not approved before timeout' };
    }
    await pool.query(
      `UPDATE payment_intents
          SET provider_status = $1, provider_amount_minor = $2, provider_currency = $3,
              provider_mode = $4, provider_fee_minor = 0, updated_at = NOW()
        WHERE id = $5 AND direction = 'disbursement' AND status = ANY($6::text[])`,
      [safeError(lookup.transaction.status), verdict.providerAmountMinor, verdict.providerCurrency,
        verdict.providerMode, intentId, OPEN_STATUSES]
    );
    return { status: 'processing', settled: false, error: null };
  }
  if (verdict.state === 'failed') {
    await pool.query(
      `UPDATE payment_intents
          SET status = 'failed', provider_status = $1, provider_amount_minor = $2,
              provider_currency = $3, provider_mode = $4, provider_fee_minor = 0,
              failure_reason = $5, updated_at = NOW()
        WHERE id = $6 AND direction = 'disbursement' AND status = ANY($7::text[])`,
      [safeError(lookup.transaction.status), verdict.providerAmountMinor, verdict.providerCurrency,
        verdict.providerMode, verdict.reason, intentId, OPEN_STATUSES]
    );
    return { status: 'failed', settled: false, error: verdict.reason };
  }
  if (verdict.state === 'review') {
    await pool.query(
      `UPDATE payment_intents
          SET status = 'review', provider_status = $1, provider_amount_minor = $2,
              provider_currency = $3, provider_mode = $4, provider_fee_minor = 0,
              failure_reason = $5, updated_at = NOW()
        WHERE id = $6 AND direction = 'disbursement' AND status = ANY($7::text[])`,
      [safeError(lookup.transaction.status), verdict.providerAmountMinor, verdict.providerCurrency,
        verdict.providerMode, verdict.reason, intentId, OPEN_STATUSES]
    );
    return { status: 'review', settled: false, error: verdict.reason };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query("SELECT * FROM payment_intents WHERE id = $1 AND direction = 'disbursement' FOR UPDATE", [intentId]);
    const current = locked.rows[0];
    if (!current || current.status === 'settled') {
      await client.query('ROLLBACK');
      return { status: current?.status || 'failed', settled: current?.status === 'settled', error: null };
    }
    if (!OPEN_STATUSES.includes(current.status)) {
      await client.query('ROLLBACK');
      return { status: current.status, settled: false, error: null };
    }

    const balances = await client.query(
      `SELECT COALESCE(SUM(CASE WHEN entry_type = 'CREDIT' THEN amount ELSE -amount END), 0) AS balance
         FROM ledger_entries WHERE member_account_id = $1`,
      [current.member_account_id]
    );
    const available = Number(balances.rows[0]?.balance || 0);
    if (available < Number(current.amount_minor)) {
      await client.query(
        `UPDATE payment_intents
            SET status = 'review', provider_status = $1, provider_amount_minor = $2,
                provider_currency = $3, provider_mode = $4, provider_fee_minor = 0,
                failure_reason = 'Provider paid the recipient but the member balance is no longer sufficient; reconcile manually',
                updated_at = NOW()
          WHERE id = $5`,
        [safeError(lookup.transaction.status), verdict.providerAmountMinor, verdict.providerCurrency,
          verdict.providerMode, intentId]
      );
      await client.query('COMMIT');
      return { status: 'review', settled: false, error: 'Provider paid the recipient; manual reconciliation is required' };
    }

    const transaction = await client.query(
      `INSERT INTO transactions (description, transaction_type, reference, metadata, created_by)
       VALUES ($1, 'withdrawal', $2, $3::jsonb, $4) RETURNING id`,
      ['MarzPay mobile money withdrawal', current.provider_reference, JSON.stringify({ provider: 'marzpay', mode: 'automatic', direction: 'disbursement', provider_uuid: current.provider_uuid, payment_intent_id: current.id }), current.created_by]
    );
    const transactionId = transaction.rows[0].id;
    const amount = Number(current.amount_minor);
    await client.query(
      `INSERT INTO ledger_entries (transaction_id, member_account_id, entry_type, amount, currency, description)
       VALUES ($1, $2, 'DEBIT', $3, 'UGX', $4)`,
      [transactionId, current.member_account_id, amount, 'Member mobile money withdrawal']
    );
    await client.query(
      `INSERT INTO ledger_entries (transaction_id, account_id, entry_type, amount, currency, description)
       VALUES ($1, $2, 'CREDIT', $3, 'UGX', $4)`,
      [transactionId, current.settlement_account_id, amount, 'MarzPay disbursement settlement']
    );
    await client.query(
      `INSERT INTO ledger (account_id, amount, currency, source_type, source_id, description, entry_date, created_by)
       VALUES ($1, $2, 'UGX', 'withdrawal', $3, $4, CURRENT_DATE, $5)`,
      [current.settlement_account_id, -amount, transactionId, 'MarzPay disbursement settlement', current.created_by]
    );
    await client.query(
      `UPDATE payment_intents
          SET status = 'settled', provider_status = $1, provider_amount_minor = $2,
              provider_currency = $3, provider_mode = $4, provider_fee_minor = 0,
              ledger_amount_minor = $5, transaction_id = $6, settled_at = NOW(),
              failure_reason = NULL, updated_at = NOW()
        WHERE id = $7`,
      [safeError(lookup.transaction.status), verdict.providerAmountMinor, verdict.providerCurrency,
        verdict.providerMode, amount, transactionId, intentId]
    );
    await client.query('COMMIT');
    return { status: 'settled', settled: true, error: null };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
