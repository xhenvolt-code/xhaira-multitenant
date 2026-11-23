import { createHmac, timingSafeEqual } from 'node:crypto';

function getSecret() {
  const secret = process.env.RECEIPT_QR_SECRET?.trim() || process.env.NEXTAUTH_SECRET?.trim();
  if (!secret || Buffer.byteLength(secret) < 32) {
    throw new Error('Set RECEIPT_QR_SECRET to a random value of at least 32 bytes to enable receipt QR seals');
  }
  return secret;
}

function signatureFor(receiptNumber) {
  return createHmac('sha256', getSecret())
    .update(`xhaira-receipt-v1:${receiptNumber}`)
    .digest('base64url');
}

export function createReceiptVerificationUrl(receiptNumber, origin) {
  const url = new URL('/verify/receipt', origin);
  url.searchParams.set('number', receiptNumber);
  url.searchParams.set('stamp', signatureFor(receiptNumber));
  return url.toString();
}

export function isValidReceiptStamp(receiptNumber, stamp) {
  if (!/^RCP-[A-F0-9]{32}$/.test(String(receiptNumber || '')) ||
      typeof stamp !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(stamp)) return false;
  try {
    const expected = Buffer.from(signatureFor(receiptNumber));
    const supplied = Buffer.from(stamp);
    return expected.length === supplied.length && timingSafeEqual(expected, supplied);
  } catch {
    return false;
  }
}
