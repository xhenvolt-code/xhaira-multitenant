import { createHmac, timingSafeEqual } from 'node:crypto';

const DEFAULT_BASE = 'https://wallet.wearemarz.com/api/v1';

function normalizeAmountMinor(raw) {
  if (typeof raw === 'number') return Number.isSafeInteger(raw) ? raw : null;
  if (typeof raw !== 'string' || !/^\d+(?:\.0+)?$/.test(raw.trim())) return null;
  const amount = Number(raw);
  return Number.isSafeInteger(amount) ? amount : null;
}

export function getMarzpayConfig() {
  const apiKey = process.env.MARZPAY_API_KEY?.trim();
  const apiSecret = process.env.MARZPAY_API_SECRET?.trim();
  if (!apiKey || !apiSecret) return null;
  return {
    apiKey,
    apiSecret,
    baseUrl: (process.env.MARZPAY_BASE_URL?.trim() || DEFAULT_BASE).replace(/\/+$/, ''),
    webhookSecret: process.env.MARZPAY_WEBHOOK_SECRET?.trim() || null,
  };
}

export const isMarzpayConfigured = () => getMarzpayConfig() !== null;

export function normalizeMarzpayTransaction(body, direction = null) {
  const root = body?.data ?? body ?? {};
  const transaction = root.transaction ?? {};
  const collection = root.collection ?? {};
  const disbursement = root.disbursement ?? {};
  const preferred = direction === 'disbursement' ? disbursement
    : direction === 'collection' ? collection
      : null;
  const amount = preferred?.amount ?? collection.amount ?? disbursement.amount ?? transaction.amount ?? root.amount ?? {};
  const fee = preferred?.fee ?? transaction.fee ?? collection.fee ?? disbursement.fee ?? root.fee ?? null;
  const raw = amount && typeof amount === 'object'
    ? amount.raw ?? amount.value ?? amount.amount ?? null
    : amount;
  const rawFee = fee && typeof fee === 'object'
    ? fee.raw ?? fee.value ?? fee.amount ?? null
    : fee;
  return {
    uuid: transaction.uuid ?? preferred?.uuid ?? collection.uuid ?? disbursement.uuid ?? null,
    reference: transaction.reference ?? preferred?.reference ?? collection.reference ?? disbursement.reference ?? null,
    status: transaction.status ?? preferred?.status ?? collection.status ?? disbursement.status ?? null,
    mode: preferred?.mode ?? collection.mode ?? disbursement.mode ?? transaction.mode ?? null,
    currency: (amount && typeof amount === 'object' ? amount.currency : null) ??
      preferred?.currency ?? transaction.currency ?? collection.currency ?? disbursement.currency ?? root.currency ?? null,
    amountMinor: normalizeAmountMinor(raw),
    feeMinor: normalizeAmountMinor(rawFee),
    provider: preferred?.provider ?? collection.provider ?? disbursement.provider ?? transaction.provider ?? null,
    message: transaction.message ?? preferred?.message ?? collection.message ?? disbursement.message ?? root.message ?? null,
  };
}

async function requestMarzpay(method, path, body, formData = false) {
  const config = getMarzpayConfig();
  if (!config) return { ok: false, status: 0, json: null, error: 'MarzPay is not configured' };
  try {
    const response = await fetch(`${config.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.apiKey}:${config.apiSecret}`).toString('base64')}`,
        Accept: 'application/json',
        ...(body && !formData ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? (formData ? body : JSON.stringify(body)) : undefined,
      signal: AbortSignal.timeout(25000),
    });
    const json = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, json, error: json?.message || json?.error || json?.detail || null };
  } catch (error) {
    return { ok: false, status: 0, json: null, error: error?.name === 'TimeoutError' ? 'MarzPay response timed out' : 'MarzPay network request failed' };
  }
}

const phoneVerificationCache = new Map();

function normalizeUgandaPhoneForVerification(value) {
  let digits = String(value || '').replace(/[\s()+-]/g, '');
  if (/^0[37]\d{8}$/.test(digits)) digits = `256${digits.slice(1)}`;
  else if (/^[37]\d{8}$/.test(digits)) digits = `256${digits}`;
  return /^256[37]\d{8}$/.test(digits) ? digits : null;
}

export async function verifyMarzpayPhone(value) {
  const phoneNumber = normalizeUgandaPhoneForVerification(value);
  if (!phoneNumber) return { ok: false, status: 400, error: 'Enter a valid Uganda mobile number, for example 077… or +25677…' };

  const cached = phoneVerificationCache.get(phoneNumber);
  if (cached && cached.expiresAt > Date.now()) return { ...cached.result, cached: true };

  const response = await requestMarzpay('POST', '/phone-verification/verify', { phone_number: phoneNumber });
  const root = response.json || {};
  const data = root.data || {};
  if (!response.ok || root.success !== true) {
    const status = response.status === 404 ? 404
      : response.status === 400 || response.status === 422 ? 400
        : response.status === 401 || response.status === 403 ? 503
          : response.status === 0 || response.status >= 500 ? 502 : 400;
    return { ok: false, status, error: String(root.message || root.error || response.error || 'MarzPay could not verify this phone number').slice(0, 200) };
  }

  const fullName = String(data.full_name || [data.first_name, data.last_name].filter(Boolean).join(' ')).trim().slice(0, 255);
  const verifiedPhone = normalizeUgandaPhoneForVerification(data.phone_number || root.phone_number || phoneNumber);
  if (!fullName || verifiedPhone !== phoneNumber || String(data.verification_status || '').toLowerCase() !== 'verified') {
    return { ok: false, status: 502, error: 'MarzPay returned an incomplete phone verification result' };
  }

  const result = { ok: true, phoneNumber, fullName, firstName: String(data.first_name || '').trim(), lastName: String(data.last_name || '').trim() };
  phoneVerificationCache.set(phoneNumber, { result, expiresAt: Date.now() + 60 * 60 * 1000 });
  if (phoneVerificationCache.size > 2000) {
    const now = Date.now();
    for (const [key, entry] of phoneVerificationCache) {
      if (entry.expiresAt <= now || phoneVerificationCache.size > 1800) phoneVerificationCache.delete(key);
    }
  }
  return result;
}

function flattenMetadata(metadata) {
  return metadata.flatMap(item => Object.entries(item || {}).map(([key, value]) => ({ [key]: String(value) }))).slice(0, 10);
}

export async function collectMarzpayMoney({ amountUgx, phone, reference, description, callbackUrl, metadata = [] }) {
  if (!Number.isSafeInteger(amountUgx) || amountUgx <= 0) return { ok: false, outcomeUnknown: false, transaction: null, error: 'Amount must be a positive whole number of UGX' };
  const base = {
    amount: amountUgx,
    country: 'UG',
    reference,
    phone_number: phone,
    description: String(description || 'Xhaira mobile money collection').slice(0, 255),
    ...(callbackUrl ? { callback_url: callbackUrl.slice(0, 255) } : {}),
  };
  const flatMetadata = flattenMetadata(metadata);
  let response = await requestMarzpay('POST', '/collect-money', flatMetadata.length ? { ...base, metadata: flatMetadata } : base);
  if (!response.ok && response.status >= 400 && response.status < 500 && flatMetadata.length && /metadata/i.test(JSON.stringify(response.json))) {
    response = await requestMarzpay('POST', '/collect-money', base);
  }
  if (!response.ok || String(response.json?.status || '').toLowerCase() === 'error') {
    return { ok: false, outcomeUnknown: response.status === 0 || response.status >= 500, transaction: null, error: String(response.error || `MarzPay returned HTTP ${response.status}`).slice(0, 240) };
  }
  return { ok: true, outcomeUnknown: false, transaction: normalizeMarzpayTransaction(response.json, 'collection'), error: null };
}

export async function getMarzpayCollection(uuid) {
  if (!/^[0-9a-fA-F-]{20,64}$/.test(String(uuid || ''))) return { ok: false, transaction: null, error: 'Invalid provider transaction ID' };
  const response = await requestMarzpay('GET', `/collect-money/${encodeURIComponent(uuid)}`);
  if (!response.ok) return { ok: false, transaction: null, error: String(response.error || `MarzPay returned HTTP ${response.status}`).slice(0, 240) };
  return { ok: true, transaction: normalizeMarzpayTransaction(response.json, 'collection'), error: null };
}

export async function sendMarzpayMoney({ amountUgx, phone, reference, description, callbackUrl, metadata = [] }) {
  if (!Number.isSafeInteger(amountUgx) || amountUgx <= 0) return { ok: false, outcomeUnknown: false, transaction: null, error: 'Amount must be a positive whole number of UGX' };
  const body = new FormData();
  body.set('amount', String(amountUgx));
  body.set('country', 'UG');
  body.set('phone_number', phone);
  body.set('reference', reference);
  body.set('description', String(description || 'Xhaira mobile money payout').slice(0, 255));
  if (callbackUrl) body.set('callback_url', callbackUrl.slice(0, 255));
  const flatMetadata = flattenMetadata(metadata);
  if (flatMetadata.length) body.set('metadata', JSON.stringify(flatMetadata));
  const response = await requestMarzpay('POST', '/send-money', body, true);
  if (!response.ok || String(response.json?.status || '').toLowerCase() === 'error') {
    return { ok: false, outcomeUnknown: response.status === 0 || response.status >= 500, transaction: null, error: String(response.error || `MarzPay returned HTTP ${response.status}`).slice(0, 240) };
  }
  return { ok: true, outcomeUnknown: false, transaction: normalizeMarzpayTransaction(response.json, 'disbursement'), error: null };
}

export async function getMarzpayDisbursement(uuid) {
  if (!/^[0-9a-fA-F-]{20,64}$/.test(String(uuid || ''))) return { ok: false, transaction: null, error: 'Invalid provider transaction ID' };
  const response = await requestMarzpay('GET', `/send-money/${encodeURIComponent(uuid)}`);
  if (!response.ok) return { ok: false, transaction: null, error: String(response.error || `MarzPay returned HTTP ${response.status}`).slice(0, 240) };
  return { ok: true, transaction: normalizeMarzpayTransaction(response.json, 'disbursement'), error: null };
}

export function verifyMarzpayWebhook(rawBody, signatureHeader, secret, nowMs = Date.now()) {
  if (!signatureHeader) return 'unsigned';
  const match = /t=(\d+)\s*,\s*v1=([0-9a-fA-F]+)/.exec(String(signatureHeader));
  if (!match || Math.abs(nowMs / 1000 - Number(match[1])) > 300) return 'invalid';
  const expected = createHmac('sha256', secret).update(`${match[1]}.${rawBody}`).digest();
  const received = Buffer.from(match[2], 'hex');
  return expected.length === received.length && timingSafeEqual(expected, received) ? 'valid' : 'invalid';
}

export function judgeMarzpayCollection(transaction, expectedAmount, { allowLowerAmount = false, acceptCompletedAmountMismatch = false, feeBasisPoints = 0 } = {}) {
  const status = String(transaction?.status || '').trim().toLowerCase();
  const mode = String(transaction?.mode || '').trim().toLowerCase();
  const providerAmountMinor = Number.isSafeInteger(transaction?.amountMinor) ? transaction.amountMinor : null;
  const providerCurrency = typeof transaction?.currency === 'string' ? transaction.currency.trim().toUpperCase().slice(0, 16) : null;
  const evidence = { providerAmountMinor, providerCurrency, providerMode: mode.slice(0, 32) || null };
  const allowSandbox = process.env.NODE_ENV !== 'production' && process.env.MARZPAY_ALLOW_SANDBOX === '1';
  if (['failed', 'cancelled', 'canceled', 'rejected', 'expired'].includes(status)) return { state: 'failed', reason: transaction?.message || `MarzPay reports ${status}`, ...evidence };
  if (!['completed', 'successful', 'success', 'sandbox'].includes(status)) return { state: 'processing', reason: null, ...evidence };
  if ((mode === 'sandbox' || status === 'sandbox') && !allowSandbox) return { state: 'failed', reason: 'Sandbox transactions cannot settle real payments', ...evidence };
  if (providerCurrency !== 'UGX') return { state: 'review', reason: 'Provider currency is not UGX', ...evidence };
  if (!Number.isSafeInteger(expectedAmount) || expectedAmount <= 0 || providerAmountMinor === null || providerAmountMinor <= 0) {
    return { state: 'review', reason: 'Provider amount does not match the requested amount', ...evidence };
  }
  if (!acceptCompletedAmountMismatch && providerAmountMinor < expectedAmount && !allowLowerAmount) {
    return { state: 'review', reason: 'Provider amount does not match the requested amount', ...evidence };
  }
  if (!acceptCompletedAmountMismatch &&
      (!Number.isSafeInteger(feeBasisPoints) || feeBasisPoints < 0 || feeBasisPoints > 10000)) {
    return { state: 'review', reason: 'Organization collection-fee configuration is invalid', ...evidence };
  }
  const providerFeeMinor = providerAmountMinor > expectedAmount
    ? acceptCompletedAmountMismatch
      ? providerAmountMinor - expectedAmount
      : Number((BigInt(expectedAmount) * BigInt(feeBasisPoints) + 5000n) / 10000n)
    : 0;
  const ledgerAmountMinor = acceptCompletedAmountMismatch
    ? Math.min(providerAmountMinor, expectedAmount)
    : providerAmountMinor > expectedAmount
      ? expectedAmount
      : providerAmountMinor;
  if (!acceptCompletedAmountMismatch && providerAmountMinor > expectedAmount &&
      (providerFeeMinor <= 0 || BigInt(expectedAmount) + BigInt(providerFeeMinor) !== BigInt(providerAmountMinor))) {
    return { state: 'review', reason: 'Provider amount exceeds the request and does not match the configured collection fee', ...evidence };
  }
  return {
    state: 'settled',
    reason: null,
    ...evidence,
    ledgerAmountMinor,
    providerFeeMinor,
    amountDifferenceMinor: Math.abs(providerAmountMinor - expectedAmount),
  };
}
