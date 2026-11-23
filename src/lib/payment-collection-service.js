import { getPool } from '@/lib/db.js';
import { collectMarzpayMoney, getMarzpayCollection, isMarzpayConfigured, judgeMarzpayCollection } from '@/lib/payments/marzpay.js';
import { getMarzpayCollectionFeeBasisPoints, getMarzpaySettlementAccount } from '@/lib/payments/settlement-account.js';
import { syncMobileMoneyDisbursement } from '@/lib/payment-disbursement-service.js';

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

export async function createMobileMoneyCollection({ amountUgx, phone, memberAccountId, organizationAccountId, idempotencyKey, userId, callbackUrl, reason, depositorName, receiverName, organizationTransaction }) {
  if (!isMarzpayConfigured()) return { ok: false, status: 503, error: 'MarzPay is not configured' };
  if (!Number.isSafeInteger(amountUgx) || amountUgx <= 0) return { ok: false, status: 400, error: 'Amount must be a positive whole number of UGX' };
  const isOrganizationAccount = Boolean(organizationAccountId);
  const destinationAccountId = isOrganizationAccount ? organizationAccountId : memberAccountId;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(destinationAccountId || '')) ||
      (isOrganizationAccount && memberAccountId)) {
    return { ok: false, status: 400, error: 'Select one valid destination account' };
  }
  const normalizedPhone = normalizeUgandaPhone(phone);
  if (!normalizedPhone) return { ok: false, status: 400, error: 'Enter a valid Uganda mobile money number' };
  if (!/^[\w:.-]{8,128}$/.test(String(idempotencyKey || ''))) return { ok: false, status: 400, error: 'A valid Idempotency-Key header is required' };
  if (!String(reason || '').trim() || String(reason).trim().length > 1000 ||
      String(depositorName || '').trim().length > 255 ||
      !String(receiverName || '').trim() || String(receiverName).trim().length > 255) {
    return { ok: false, status: 400, error: 'Deposit reason and receiver name are required; depositor name is optional' };
  }

  if (isOrganizationAccount) {
    const organizationAccountSchema = await getPool().query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'payment_intents'
            AND column_name = 'organization_account_id'
       ) AS ready`
    );
    if (!organizationAccountSchema.rows[0]?.ready) {
      return { ok: false, status: 503, error: 'Organization MarzPay schema is not ready; apply migration 983_organization_marzpay_transactions.sql' };
    }
  }

  const existing = await getPool().query(
    `SELECT id, direction, status, amount_minor, settlement_account_id, member_account_id,
            ${isOrganizationAccount ? 'organization_account_id,' : ''} metadata
       FROM payment_intents WHERE idempotency_key = $1 LIMIT 1`,
    [idempotencyKey]
  );
  if (existing.rows[0]) {
    const intent = existing.rows[0];
    if (intent.direction !== 'collection' || Number(intent.amount_minor) !== amountUgx ||
        intent.member_account_id !== (isOrganizationAccount ? null : memberAccountId) ||
        (isOrganizationAccount && intent.organization_account_id !== organizationAccountId) ||
        (isOrganizationAccount && intent.metadata?.request_fingerprint !== organizationTransaction?.request_fingerprint)) {
      return { ok: false, status: 409, error: 'Idempotency key was already used with different payment details' };
    }
    return { ok: true, duplicate: true, id: intent.id, status: intent.status, amountUgx: Number(intent.amount_minor) };
  }

  const settlementAccount = await getMarzpaySettlementAccount();
  if (!settlementAccount) {
    return { ok: false, status: 409, error: 'Configure an active UGX MarzPay settlement account in organization settings before collecting payments' };
  }
  const feeBasisPoints = await getMarzpayCollectionFeeBasisPoints();
  if (feeBasisPoints === null) {
    return { ok: false, status: 503, error: 'Organization MarzPay collection-fee settings are missing or invalid; no payment was sent' };
  }
  const schema = await getPool().query(
    `SELECT COUNT(*)::int AS column_count
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'payment_intents'
        AND column_name = ANY($1::text[])`,
    [['provider_amount_minor', 'provider_currency', 'provider_mode', 'ledger_amount_minor', 'provider_fee_minor']]
  );
  const directionConstraint = await getPool().query(
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
  const accountCheck = isOrganizationAccount
    ? await getPool().query(
      `SELECT a.id, a.name AS full_name
         FROM accounts a
        WHERE a.id = $1 AND a.organization_id = public.current_organization_id()
          AND a.currency = 'UGX' AND a.type = 'mobile_money'
          AND a.is_active = true AND a.status = 'active'`,
      [organizationAccountId]
    )
    : await getPool().query(
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
  if (!accountCheck.rows[0] || (isOrganizationAccount && organizationAccountId !== settlementAccountId)) {
    return { ok: false, status: 400, error: 'Select the configured active UGX MarzPay organization account' };
  }
  if (accountCheck.rows[0].full_name !== receiverName) {
    return { ok: false, status: 400, error: 'Receiver name must match the selected account holder' };
  }

  const intentMetadata = JSON.stringify({
    reason: reason.trim(),
    depositor_name: String(depositorName || '').trim().slice(0, 255) || null,
    receiver_name: receiverName.trim(),
    ...(isOrganizationAccount ? { ...organizationTransaction, transaction_scope: 'organization', account_id: organizationAccountId, transaction_type: 'deposit', payment_method: 'mobile_money' } : {}),
  });
  const inserted = isOrganizationAccount
    ? await getPool().query(
      `INSERT INTO payment_intents
         (idempotency_key, amount_minor, settlement_account_id, member_account_id,
          organization_account_id, phone_masked, metadata, created_by)
       VALUES ($1, $2, $3, NULL, $4, $5, $6::jsonb, $7)
       ON CONFLICT (organization_id, idempotency_key) DO NOTHING
       RETURNING id, provider_reference, status`,
      [idempotencyKey, amountUgx, settlementAccountId, organizationAccountId,
        `${normalizedPhone.slice(0, 6)}***${normalizedPhone.slice(-3)}`, intentMetadata, userId]
    )
    : await getPool().query(
      `INSERT INTO payment_intents
         (idempotency_key, amount_minor, settlement_account_id, member_account_id, phone_masked, metadata, created_by)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       ON CONFLICT (organization_id, idempotency_key) DO NOTHING
       RETURNING id, provider_reference, status`,
      [idempotencyKey, amountUgx, settlementAccountId, memberAccountId,
        `${normalizedPhone.slice(0, 6)}***${normalizedPhone.slice(-3)}`, intentMetadata, userId]
    );
  if (!inserted.rows[0]) {
    const duplicate = await getPool().query(
      `SELECT id, direction, status, amount_minor, settlement_account_id, member_account_id,
              ${isOrganizationAccount ? 'organization_account_id,' : ''} metadata
         FROM payment_intents WHERE idempotency_key = $1 LIMIT 1`,
      [idempotencyKey]
    );
    if (!duplicate.rows[0]) return { ok: false, status: 409, error: 'Could not reserve this idempotency key' };
    if (duplicate.rows[0].direction !== 'collection' || Number(duplicate.rows[0].amount_minor) !== amountUgx ||
        duplicate.rows[0].member_account_id !== (isOrganizationAccount ? null : memberAccountId) ||
        (isOrganizationAccount && duplicate.rows[0].organization_account_id !== organizationAccountId) ||
        (isOrganizationAccount && duplicate.rows[0].metadata?.request_fingerprint !== organizationTransaction?.request_fingerprint)) {
      return { ok: false, status: 409, error: 'Idempotency key was already used with different payment details' };
    }
    return { ok: true, duplicate: true, id: duplicate.rows[0].id, status: duplicate.rows[0].status, amountUgx: Number(duplicate.rows[0].amount_minor) };
  }

  const intent = inserted.rows[0];
  const started = await collectMarzpayMoney({
    amountUgx,
    phone: normalizedPhone,
    reference: intent.provider_reference,
    description: 'Xhaira SACCO mobile money collection',
    callbackUrl,
    metadata: [{ payment_intent_id: intent.id }, { organization_id: (await getPool().query('SELECT public.current_organization_id() id')).rows[0].id }],
  });

  if (!started.ok) {
    const state = started.outcomeUnknown ? 'review' : 'failed';
    await getPool().query(
      'UPDATE payment_intents SET status = $1, failure_reason = $2, updated_at = NOW() WHERE id = $3 AND status = $4',
      [state, safeError(started.error), intent.id, 'created']
    );
    return { ok: false, status: started.outcomeUnknown ? 202 : 502, id: intent.id, state, error: safeError(started.error) };
  }

  const providerUuid = started.transaction?.uuid;
  if (!providerUuid) {
    await getPool().query(
      "UPDATE payment_intents SET status = 'review', failure_reason = $1, updated_at = NOW() WHERE id = $2 AND status = 'created'",
      ['MarzPay did not return a collection identifier; manual reconciliation required', intent.id]
    );
    return { ok: true, id: intent.id, status: 'review', amountUgx };
  }

  await getPool().query(
    "UPDATE payment_intents SET provider_uuid = $1, provider_status = $2, status = 'processing', updated_at = NOW() WHERE id = $3 AND status = 'created'",
    [providerUuid, safeError(started.transaction.status), intent.id]
  );
  const synced = await syncMobileMoneyCollection(intent.id);
  return { ok: true, id: intent.id, status: synced.status, amountUgx };
}

export async function syncMobileMoneyCollection(intentId, providerUuidHint = null) {
  const pool = getPool();
  if (providerUuidHint && /^[0-9a-fA-F-]{20,64}$/.test(providerUuidHint)) {
    await pool.query(
      "UPDATE payment_intents SET provider_uuid = COALESCE(provider_uuid, $1), status = CASE WHEN status = 'review' AND provider_uuid IS NULL THEN 'processing' ELSE status END, updated_at = NOW() WHERE id = $2 AND status IN ('created','processing','review')",
      [providerUuidHint, intentId]
    );
  }
  const initial = await pool.query(
    'SELECT id, status, provider_uuid, amount_minor, created_at FROM payment_intents WHERE id = $1 LIMIT 1',
    [intentId]
  );
  const row = initial.rows[0];
  if (!row) return { status: 'failed', settled: false, error: 'Payment intent not found' };
  if (row.status === 'settled' || row.status === 'failed' || row.status === 'expired') {
    return { status: row.status, settled: row.status === 'settled', error: null };
  }
  if (!row.provider_uuid) return { status: row.status, settled: false, error: row.status === 'review' ? 'Payment needs reconciliation' : null };

  const lookup = await getMarzpayCollection(row.provider_uuid);
  if (!lookup.ok || !lookup.transaction) return { status: row.status, settled: false, error: safeError(lookup.error) };
  const verdict = judgeMarzpayCollection(lookup.transaction, Number(row.amount_minor), {
    allowLowerAmount: true,
    acceptCompletedAmountMismatch: true,
  });

  if (verdict.state === 'processing') {
    if (Date.now() - new Date(row.created_at).getTime() > 30 * 60 * 1000) {
      await pool.query("UPDATE payment_intents SET status = 'expired', provider_status = $1, failure_reason = 'Collection was not approved before timeout', updated_at = NOW() WHERE id = $2 AND status IN ('created','processing')", [safeError(lookup.transaction.status), intentId]);
      return { status: 'expired', settled: false, error: 'Collection was not approved before timeout' };
    }
    await pool.query(
      `UPDATE payment_intents
          SET provider_status = $1, provider_amount_minor = $2, provider_currency = $3,
              provider_mode = $4, provider_fee_minor = 0, updated_at = NOW()
        WHERE id = $5 AND status = ANY($6::text[])`,
      [safeError(lookup.transaction.status), verdict.providerAmountMinor, verdict.providerCurrency, verdict.providerMode, intentId, OPEN_STATUSES]
    );
    return { status: 'processing', settled: false, error: null };
  }
  if (verdict.state === 'failed') {
    await pool.query(
      `UPDATE payment_intents
          SET status = 'failed', provider_status = $1, provider_amount_minor = $2,
              provider_currency = $3, provider_mode = $4, provider_fee_minor = 0,
              failure_reason = $5, updated_at = NOW()
        WHERE id = $6 AND status = ANY($7::text[])`,
      [safeError(lookup.transaction.status), verdict.providerAmountMinor, verdict.providerCurrency, verdict.providerMode, verdict.reason, intentId, OPEN_STATUSES]
    );
    return { status: 'failed', settled: false, error: verdict.reason };
  }
  if (verdict.state === 'review') {
    await pool.query(
      `UPDATE payment_intents
          SET status = 'review', provider_status = $1, provider_amount_minor = $2,
              provider_currency = $3, provider_mode = $4, provider_fee_minor = 0,
              failure_reason = $5, updated_at = NOW()
        WHERE id = $6 AND status = ANY($7::text[])`,
      [safeError(lookup.transaction.status), verdict.providerAmountMinor, verdict.providerCurrency, verdict.providerMode, verdict.reason, intentId, OPEN_STATUSES]
    );
    return { status: 'review', settled: false, error: verdict.reason };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query('SELECT * FROM payment_intents WHERE id = $1 FOR UPDATE', [intentId]);
    const current = locked.rows[0];
    if (!current || current.status === 'settled') {
      await client.query('ROLLBACK');
      return { status: current?.status || 'failed', settled: current?.status === 'settled', error: null };
    }
    if (!OPEN_STATUSES.includes(current.status)) {
      await client.query('ROLLBACK');
      return { status: current.status, settled: false, error: null };
    }

    const isOrganizationAccount = Boolean(current.organization_account_id);
    const description = current.metadata?.reason || (isOrganizationAccount
      ? 'Organization mobile money deposit'
      : 'Mobile money deposit');
    const transactionMetadata = {
      ...(isOrganizationAccount ? current.metadata : {}),
      provider: 'marzpay',
      provider_uuid: current.provider_uuid,
      payment_intent_id: current.id,
      reason: description,
      depositor_name: current.metadata?.depositor_name || null,
      receiver_name: current.metadata?.receiver_name || null,
      requested_amount_minor: Number(current.amount_minor),
      provider_amount_minor: verdict.providerAmountMinor,
      provider_fee_minor: verdict.providerFeeMinor,
      fee_bearer: verdict.providerFeeMinor > 0 ? 'payer' : null,
      ledger_amount_minor: verdict.ledgerAmountMinor,
      ...(isOrganizationAccount ? {
        transaction_scope: 'organization',
        transaction_type: 'deposit',
        account_id: current.organization_account_id,
        payment_method: 'mobile_money',
      } : {}),
    };
    const transaction = await client.query(
      `INSERT INTO transactions
         (description, transaction_type, reference, metadata, reason, depositor_name, receiver_name,
          principal_minor, transaction_charges_minor, created_by)
       VALUES ($1, 'deposit', $2, $3::jsonb, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [description, current.provider_reference, JSON.stringify(transactionMetadata), description, current.metadata?.depositor_name || null,
        current.metadata?.receiver_name || null, Number(current.amount_minor),
        Number.isSafeInteger(Number(current.fee_calculation?.transactionChargesMinor))
          ? Number(current.fee_calculation.transactionChargesMinor)
          : Number.isSafeInteger(verdict.providerFeeMinor) ? verdict.providerFeeMinor : null,
        current.created_by]
    );
    const transactionId = transaction.rows[0].id;
    const amount = verdict.ledgerAmountMinor;
    if (current.organization_account_id) {
      await client.query(
        `INSERT INTO ledger
           (organization_id, account_id, amount, currency, source_type, source_id,
            description, category, entry_date, metadata, created_by)
         VALUES ($1, $2, $3, 'UGX', 'deposit', $4, $5, $6, $7::date, $8::jsonb, $9)`,
        [(await client.query('SELECT public.current_organization_id() AS id')).rows[0].id,
          current.organization_account_id, amount, transactionId, description,
          current.metadata?.classification || 'deposit', current.metadata?.transaction_date || new Date().toISOString().slice(0, 10),
          JSON.stringify(transactionMetadata), current.created_by]
      );
      await client.query(
        `INSERT INTO audit_logs (organization_id, user_id, action, entity_type, entity_id, details)
         VALUES (public.current_organization_id(), $1, 'DEPOSIT', 'organization_transaction', $2, $3::jsonb)`,
        [current.created_by, transactionId, JSON.stringify({
          account_id: current.organization_account_id,
          amount: Number(amount),
          currency: 'UGX',
          reason: description,
          payment_method: 'mobile_money',
          payment_intent_id: current.id,
        })]
      );
    } else {
      await client.query(
        `INSERT INTO ledger_entries (transaction_id, account_id, entry_type, amount, currency, description)
         VALUES ($1, $2, 'DEBIT', $3, 'UGX', $4)`,
        [transactionId, current.settlement_account_id, amount, 'MarzPay collection settlement']
      );
      await client.query(
        `INSERT INTO ledger_entries (transaction_id, member_account_id, entry_type, amount, currency, description)
         VALUES ($1, $2, 'CREDIT', $3, 'UGX', $4)`,
        [transactionId, current.member_account_id, amount, 'Member savings deposit from MarzPay']
      );
      await client.query(
        `INSERT INTO ledger (account_id, amount, currency, source_type, source_id, description, entry_date, created_by)
         VALUES ($1, $2, 'UGX', 'payment', $3, $4, CURRENT_DATE, $5)`,
        [current.settlement_account_id, amount, transactionId, 'MarzPay collection settlement', current.created_by]
      );
    }
    await client.query(
      `UPDATE payment_intents
          SET status = 'settled', provider_status = $1, provider_amount_minor = $2,
              provider_currency = $3, provider_mode = $4, provider_fee_minor = $5,
              ledger_amount_minor = $6, transaction_id = $7, settled_at = NOW(),
              failure_reason = NULL, updated_at = NOW()
        WHERE id = $8`,
      [safeError(lookup.transaction.status), verdict.providerAmountMinor, verdict.providerCurrency,
        verdict.providerMode, verdict.providerFeeMinor, amount, transactionId, intentId]
    );
    await client.query('COMMIT');
    return { status: 'settled', settled: true, error: null };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.release();
  }
}

export async function syncMobileMoneyIntent(intentId, providerUuidHint = null) {
  const result = await getPool().query(
    'SELECT direction FROM payment_intents WHERE id = $1 LIMIT 1',
    [intentId]
  );
  if (result.rows[0]?.direction === 'disbursement') {
    return syncMobileMoneyDisbursement(intentId, providerUuidHint);
  }
  return syncMobileMoneyCollection(intentId, providerUuidHint);
}
