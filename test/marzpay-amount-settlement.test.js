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

test('posts the requested amount when a completed provider amount includes a surcharge', () => {
  const verdict = judgeMarzpayCollection(providerTransaction(1030), 1000, {
    allowLowerAmount: true,
    acceptCompletedAmountMismatch: true,
  });

  assert.equal(verdict.state, 'settled');
  assert.equal(verdict.providerAmountMinor, 1030);
  assert.equal(verdict.providerFeeMinor, 30);
  assert.equal(verdict.ledgerAmountMinor, 1000);
  assert.equal(verdict.amountDifferenceMinor, 30);
});

test('posts completed collections when the provider amount differs from the request', () => {
  const overage = judgeMarzpayCollection(providerTransaction(1031), 1000, {
    allowLowerAmount: true,
    acceptCompletedAmountMismatch: true,
  });
  assert.equal(overage.state, 'settled');
  assert.equal(overage.ledgerAmountMinor, 1000);
  assert.equal(overage.providerFeeMinor, 31);

  const partial = judgeMarzpayCollection(providerTransaction(970), 1000, {
    allowLowerAmount: true,
    acceptCompletedAmountMismatch: true,
  });
  assert.equal(partial.state, 'settled');
  assert.equal(partial.ledgerAmountMinor, 970);
  assert.equal(partial.providerFeeMinor, 0);
});

test('rounds configured provider fees to the nearest whole UGX using integer arithmetic', () => {
  const verdict = judgeMarzpayCollection(providerTransaction(104), 101, {
    allowLowerAmount: true,
    feeBasisPoints: 300,
  });

  assert.equal(verdict.state, 'settled');
  assert.equal(verdict.providerFeeMinor, 3);
  assert.equal(verdict.ledgerAmountMinor, 101);
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
