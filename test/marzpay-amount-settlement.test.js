import test from 'node:test';
import assert from 'node:assert/strict';
import { judgeMarzpayCollection, normalizeMarzpayTransaction } from '../src/lib/payments/marzpay.js';

function providerTransaction(amount, overrides = {}) {
  return {
    status: 'completed',
    currency: 'UGX',
    amountMinor: amount,
    ...overrides,
  };
}

test('normalizes whole UGX amounts from numeric and decimal-string provider fields', () => {
  for (const raw of [1000, '1000', '1000.0']) {
    const result = normalizeMarzpayTransaction({
      data: { transaction: { status: 'completed' }, collection: { amount: { raw, currency: 'UGX' } } },
    });
    assert.equal(result.amountMinor, 1000);
    assert.equal(judgeMarzpayCollection(result, 1000).state, 'settled');
  }
});

test('settles a completed collection for the actual lower provider amount when enabled', () => {
  const verdict = judgeMarzpayCollection(providerTransaction(970), 1000, { allowLowerAmount: true });

  assert.equal(verdict.state, 'settled');
  assert.equal(verdict.providerAmountMinor, 970);
  assert.equal(verdict.ledgerAmountMinor, 970);
  assert.equal(verdict.amountDifferenceMinor, 30);
});

test('keeps lower amounts in review for disbursements and other strict callers', () => {
  const verdict = judgeMarzpayCollection(providerTransaction(970), 1000);

  assert.equal(verdict.state, 'review');
  assert.equal(verdict.providerAmountMinor, 970);
});

test('does not settle missing, malformed, fractional, zero, or over-request provider amounts', () => {
  for (const raw of [null, '1,000', 970.5, 0, 1001]) {
    const result = normalizeMarzpayTransaction({
      data: { transaction: { status: 'completed' }, collection: { amount: { raw, currency: 'UGX' } } },
    });
    assert.equal(judgeMarzpayCollection(result, 1000, { allowLowerAmount: true }).state, 'review', String(raw));
  }
});

test('does not settle a lower amount with a non-UGX currency or non-completed provider status', () => {
  assert.equal(judgeMarzpayCollection(providerTransaction(970, { currency: 'KES' }), 1000, { allowLowerAmount: true }).state, 'review');
  assert.equal(judgeMarzpayCollection(providerTransaction(970, { status: 'pending' }), 1000, { allowLowerAmount: true }).state, 'processing');
});
