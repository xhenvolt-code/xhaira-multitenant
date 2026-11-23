import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getPool, query } from '@/lib/db.js';
import { requirePermission } from '@/lib/permissions.js';
import { runWithOrganizationContext } from '@/lib/organization-context.js';
import { createMobileMoneyCollection } from '@/lib/payment-collection-service.js';
import { createOrganizationMobileMoneyDisbursement } from '@/lib/payment-disbursement-service.js';

function callbackUrl() {
  const configured = process.env.NEXT_PUBLIC_APP_URL || process.env.API_URL;
  if (!configured) return null;
  try {
    const url = new URL(configured);
    return url.protocol === 'https:' ? `${url.origin}/api/webhooks/marzpay` : null;
  } catch {
    return null;
  }
}

const MAX_AMOUNT = /^\d{1,13}(?:\.\d{1,2})?$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function cleanOptional(value, maxLength = 255) {
  if (value == null) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

export async function GET(request) {
  const permission = await requirePermission(request, 'finance.view');
  if (permission instanceof NextResponse) return permission;
  const organizationId = permission.auth.organizationId;
  if (!organizationId) return NextResponse.json({ success: false, error: 'Organization context required' }, { status: 400 });

  try {
    return await runWithOrganizationContext(organizationId, async () => {
      const { searchParams } = new URL(request.url);
      const accountId = searchParams.get('account_id');
      const type = searchParams.get('type');
      const fromDate = searchParams.get('from_date');
      const toDate = searchParams.get('to_date');
      const limit = Math.min(200, Math.max(1, Number.parseInt(searchParams.get('limit') || '50', 10) || 50));
      const offset = Math.max(0, Number.parseInt(searchParams.get('offset') || '0', 10) || 0);
      const params = [organizationId];
      let where = 't.organization_id = $1 AND t.transaction_type IN (\'deposit\', \'withdrawal\') AND t.metadata->>\'transaction_scope\' = \'organization\'';
      if (accountId) { params.push(accountId); where += ` AND t.metadata->>'account_id' = $${params.length}`; }
      if (type && ['deposit', 'withdrawal'].includes(type)) { params.push(type); where += ` AND t.transaction_type = $${params.length}`; }
      if (fromDate) { params.push(fromDate); where += ` AND (t.metadata->>'transaction_date')::date >= $${params.length}::date`; }
      if (toDate) { params.push(toDate); where += ` AND (t.metadata->>'transaction_date')::date <= $${params.length}::date`; }
      const count = await query(`SELECT COUNT(*)::int AS total FROM public.transactions t WHERE ${where}`, params);
      const rows = await query(
        `SELECT t.id, t.receipt_number, t.transaction_type, t.description, t.reference, t.metadata, t.created_at,
                u.name AS recorded_by, u.email AS recorded_by_email,
                a.name AS account_name, a.currency,
                ABS(l.amount) AS amount, l.id AS ledger_entry_id, l.entry_date
           FROM public.transactions t
           JOIN public.ledger l ON l.organization_id = t.organization_id AND l.source_id = t.id
           JOIN public.accounts a ON a.id = l.account_id AND a.organization_id = t.organization_id
           LEFT JOIN public.users u ON u.id = t.created_by AND u.organization_id = t.organization_id
          WHERE ${where}
          ORDER BY l.entry_date DESC, t.created_at DESC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      );
      const orgPaymentSchema = await query(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'payment_intents'
              AND column_name = 'organization_account_id'
         ) AS ready`
      );
      const mobileMoneyPending = orgPaymentSchema.rows[0]?.ready
        ? await query(
          `SELECT id, direction, status, provider_status, amount_minor,
                  ledger_status, reconciliation_status, reconciliation_error,
                  failure_reason, ledger_failure_reason, transaction_id, created_at,
                  metadata->>'reason' AS reason,
                  metadata->>'payment_method' AS payment_method
             FROM public.payment_intents
            WHERE organization_id = $1
              AND organization_account_id IS NOT NULL
              AND metadata->>'transaction_scope' = 'organization'
              AND status = ANY($2::text[])
            ORDER BY created_at DESC LIMIT 20`,
          [organizationId, ['created', 'processing', 'review']]
        )
        : { rows: [] };
      return NextResponse.json({ success: true, data: rows.rows,
        mobile_money_pending: mobileMoneyPending.rows,
        pagination: { total: count.rows[0].total, limit, offset } });
    });
  } catch (error) {
    console.error('[Organization transactions] GET failed:', error);
    return NextResponse.json({ success: false, error: 'Failed to load organization transactions' }, { status: 500 });
  }
}

export async function POST(request) {
  const permission = await requirePermission(request, 'finance.manage');
  if (permission instanceof NextResponse) return permission;
  const organizationId = permission.auth.organizationId;
  if (!organizationId) return NextResponse.json({ success: false, error: 'Organization context required' }, { status: 400 });

  let body;
  try { body = await request.json(); }
  catch { return NextResponse.json({ success: false, error: 'A valid JSON body is required' }, { status: 400 }); }

  const { action, account_id: accountId, amount, reason, payment_method: paymentMethod, transaction_date: transactionDate } = body || {};
  if (!['deposit', 'withdrawal'].includes(action)) {
    return NextResponse.json({ success: false, error: 'action must be deposit or withdrawal' }, { status: 400 });
  }
  if (!accountId || typeof accountId !== 'string') {
    return NextResponse.json({ success: false, error: 'An organization account is required' }, { status: 400 });
  }
  if (typeof amount !== 'string' && typeof amount !== 'number' || !MAX_AMOUNT.test(String(amount)) || Number(amount) <= 0) {
    return NextResponse.json({ success: false, error: 'Amount must be positive with no more than two decimal places' }, { status: 400 });
  }
  if (typeof reason !== 'string' || !reason.trim()) {
    return NextResponse.json({ success: false, error: 'Reason is required' }, { status: 400 });
  }
  if (reason.trim().length > 1000) return NextResponse.json({ success: false, error: 'Reason must be 1000 characters or fewer' }, { status: 400 });
  const normalizedDate = transactionDate || new Date().toISOString().slice(0, 10);
  if (typeof normalizedDate !== 'string' || !DATE_ONLY.test(normalizedDate) || Number.isNaN(Date.parse(`${normalizedDate}T00:00:00Z`)) || new Date(`${normalizedDate}T00:00:00Z`).toISOString().slice(0, 10) !== normalizedDate) {
    return NextResponse.json({ success: false, error: 'Transaction date must be a valid YYYY-MM-DD date' }, { status: 400 });
  }
  const idempotencyKey = cleanOptional(request.headers.get('Idempotency-Key') || body.idempotency_key, 128);
  if (!idempotencyKey || !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
    return NextResponse.json({ success: false, error: 'A valid Idempotency-Key header is required' }, { status: 400 });
  }
  const counterpartyName = cleanOptional(action === 'deposit' ? body.paid_by : body.withdrawn_to);
  const classification = cleanOptional(body.classification, 100);
  const notes = cleanOptional(body.notes, 2000);
  const reference = cleanOptional(body.external_reference, 255);
  const requestFingerprint = createHash('sha256').update(JSON.stringify({
    action, accountId, amount: String(amount), reason: reason.trim(), counterpartyName,
    classification, paymentMethod: paymentMethod || 'cash', normalizedDate, reference, notes,
    phone: cleanOptional(body.phone, 32),
  })).digest('hex');
  const allowedPaymentMethods = new Set(['cash', 'bank_transfer', 'mobile_money', 'cheque', 'other']);
  if (paymentMethod && !allowedPaymentMethods.has(paymentMethod)) {
    return NextResponse.json({ success: false, error: 'Unsupported payment method' }, { status: 400 });
  }

  try {
    return await runWithOrganizationContext(organizationId, async () => {
      if (paymentMethod === 'mobile_money') {
        const phone = cleanOptional(body.phone, 32);
        if (!phone) return NextResponse.json({ success: false, error: 'A mobile-money phone number is required for MarzPay' }, { status: 400 });
        if (!Number.isSafeInteger(Number(amount))) {
          return NextResponse.json({ success: false, error: 'MarzPay supports whole UGX amounts only' }, { status: 400 });
        }
        if (action === 'withdrawal' && !counterpartyName) {
          return NextResponse.json({ success: false, error: 'Recipient name is required for a MarzPay withdrawal' }, { status: 400 });
        }
        const selectedAccount = await query(
          `SELECT id, name FROM public.accounts
            WHERE id = $1 AND organization_id = $2
              AND currency = 'UGX' AND is_active IS TRUE AND status = 'active'`,
          [accountId, organizationId]
        );
        if (!selectedAccount.rows[0]) {
          return NextResponse.json({ success: false, error: 'Select an active UGX organization account' }, { status: 400 });
        }
        const organizationTransaction = {
          transaction_scope: 'organization',
          account_id: accountId,
          classification,
          transaction_date: normalizedDate,
          external_reference: reference,
          notes,
          request_fingerprint: requestFingerprint,
          ...(action === 'deposit' ? { paid_by: counterpartyName } : { withdrawn_to: counterpartyName }),
        };
        const started = action === 'deposit'
          ? await createMobileMoneyCollection({
            amountUgx: Number(amount), phone, organizationAccountId: accountId,
            idempotencyKey, userId: permission.auth.userId, callbackUrl: callbackUrl(),
            reason: reason.trim(), depositorName: counterpartyName,
            receiverName: selectedAccount.rows[0].name, organizationTransaction,
          })
          : await createOrganizationMobileMoneyDisbursement({
            amountUgx: Number(amount), phone, organizationAccountId: accountId,
            idempotencyKey, userId: permission.auth.userId, callbackUrl: callbackUrl(),
            reason: reason.trim(), receiverName: counterpartyName, organizationTransaction,
          });
        if (!started.ok) {
          return NextResponse.json({ success: false, error: started.error, id: started.id, status: started.state }, { status: started.status });
        }
        return NextResponse.json({
          success: true,
          mobile_money: true,
          duplicate: started.duplicate || false,
          data: {
            id: started.id,
            status: started.status,
            direction: action === 'deposit' ? 'collection' : 'disbursement',
            amount_minor: Number(amount),
            account_id: accountId,
            account_name: selectedAccount.rows[0].name,
            failure_reason: started.failureReason || null,
            ledger_status: started.ledgerStatus || null,
            reconciliation_status: started.reconciliationStatus || null,
          },
        }, { status: started.duplicate ? 200 : 202 });
      }

      const client = await getPool().connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`organization-ledger:${organizationId}:${accountId}`]);
        const accountResult = await client.query(
          `SELECT id, name, currency, is_active, status
             FROM public.accounts
            WHERE id = $1 AND organization_id = $2
            FOR UPDATE`,
          [accountId, organizationId]
        );
        const account = accountResult.rows[0];
        if (!account) {
          await client.query('ROLLBACK');
          return NextResponse.json({ success: false, error: 'Organization account not found' }, { status: 404 });
        }
        if (account.is_active !== true || account.status !== 'active') {
          await client.query('ROLLBACK');
          return NextResponse.json({ success: false, error: 'Account is not active' }, { status: 400 });
        }
        if (action === 'withdrawal') {
          const balance = await client.query(
            `SELECT COALESCE(SUM(amount), 0) AS available
               FROM public.ledger
              WHERE organization_id = $1 AND account_id = $2`,
            [organizationId, accountId]
          );
          const sufficient = await client.query('SELECT $1::numeric <= $2::numeric AS ok', [String(amount), balance.rows[0].available]);
          if (!sufficient.rows[0].ok) {
            await client.query('ROLLBACK');
            return NextResponse.json({ success: false, error: 'Insufficient organization account balance' }, { status: 400 });
          }
        }

        const metadata = {
          transaction_scope: 'organization',
          transaction_type: action,
          account_id: accountId,
          reason: reason.trim(),
          ...(action === 'deposit' ? { paid_by: counterpartyName } : { withdrawn_to: counterpartyName }),
          classification,
          payment_method: paymentMethod || 'cash',
          external_reference: reference,
          notes,
          transaction_date: normalizedDate,
          idempotency_key: idempotencyKey,
          request_fingerprint: requestFingerprint,
        };
        const description = reason.trim();
        const tx = await client.query(
          `INSERT INTO public.transactions (organization_id, transaction_type, description, reference, metadata, created_by)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6)
           RETURNING id, transaction_type, description, reference, metadata, created_at`,
          [organizationId, action, description, reference, JSON.stringify(metadata), permission.auth.userId]
        );
        const signedAmount = action === 'deposit' ? String(amount) : `-${String(amount)}`;
        const ledger = await client.query(
          `INSERT INTO public.ledger
             (organization_id, account_id, amount, currency, source_type, source_id, description, category, entry_date, metadata, created_by)
           VALUES ($1, $2, $3::numeric, $4, $5, $6, $7, $8, $9::date, $10::jsonb, $11)
           RETURNING *`,
          [organizationId, accountId, signedAmount, account.currency, action, tx.rows[0].id, description,
            classification || action, normalizedDate, JSON.stringify(metadata), permission.auth.userId]
        );
        await client.query(
          `INSERT INTO public.audit_logs (organization_id, user_id, action, entity_type, entity_id, details)
           VALUES ($1, $2, $3, 'organization_transaction', $4, $5::jsonb)`,
          [organizationId, permission.auth.userId, action.toUpperCase(), tx.rows[0].id,
            JSON.stringify({ account_id: accountId, amount: String(amount), currency: account.currency, reason: reason.trim(), idempotency_key: idempotencyKey })]
        );
        await client.query('COMMIT');
        return NextResponse.json({ success: true, data: { ...tx.rows[0], ledger_entry: ledger.rows[0], account_name: account.name } }, { status: 201 });
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        if (error.code === '23505' && error.constraint === 'uq_transactions_org_idempotency') {
          const existing = await query(
            `SELECT t.id, t.receipt_number, t.transaction_type, t.description, t.reference, t.metadata, t.created_at,
                    l.id AS ledger_entry_id, l.amount, l.currency, a.name AS account_name
               FROM public.transactions t
               LEFT JOIN public.ledger l ON l.organization_id = t.organization_id AND l.source_id = t.id
               LEFT JOIN public.accounts a ON a.id = l.account_id AND a.organization_id = t.organization_id
              WHERE t.organization_id = $1 AND t.metadata->>'idempotency_key' = $2
              LIMIT 1`, [organizationId, idempotencyKey]
          );
          if (existing.rows[0]) {
            if (existing.rows[0].metadata?.request_fingerprint !== requestFingerprint) {
              return NextResponse.json({ success: false, error: 'Idempotency-Key was already used for a different transaction' }, { status: 409 });
            }
            return NextResponse.json({ success: true, duplicate: true, data: existing.rows[0] });
          }
        }
        throw error;
      } finally {
        client.release();
      }
    });
  } catch (error) {
    console.error('[Organization transactions] POST failed:', error);
    return NextResponse.json({ success: false, error: 'Failed to record organization transaction' }, { status: 500 });
  }
}
