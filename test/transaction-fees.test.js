import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateTransactionFees, combineProviderFeePercentages } from '../src/lib/payments/transaction-fees.js';

test('deposit uses SACCO then platform then gateway and returns the specified example', () => {
  const result = calculateTransactionFees({
    direction: 'deposit', principalMinor: 10000,
    fees: {
      sacco: { basisPoints: 0 },
      xhenvolt: { basisPoints: 200 },
      marzpay: { basisPoints: 300 },
    },
    configurationVersions: { sacco: 1, xhenvolt: 2, marzpay: 3 },
  });
  assert.equal(result.saccoFeeMinor, 0);
  assert.equal(result.xhenvoltFeeMinor, 200);
  assert.equal(result.providerRequestedMinor, 10200);
  assert.equal(result.marzpayFeeMinor, 306);
  assert.equal(result.totalCustomerChargeMinor, 10506);
  assert.equal(result.providerChargesMinor, 506);
  assert.equal(result.expectedWalletCreditMinor, 10200);
  assert.equal(result.memberAmountCreditedMinor, 10000);
  assert.equal(result.xhenvoltRevenueMinor, 200);
  assert.deepEqual(result.configurationVersions, { sacco: 1, xhenvolt: 2, marzpay: 3 });
});

test('withdrawal keeps the gateway wallet deduction separate from member debit', () => {
  const result = calculateTransactionFees({
    direction: 'withdrawal', principalMinor: 10000,
    fees: { xhenvolt: { basisPoints: 200 }, marzpay: { basisPoints: 300 } },
  });
  assert.equal(result.providerRequestedMinor, 10000);
  assert.equal(result.marzpayFeeMinor, 300);
  assert.equal(result.expectedWalletDeductionMinor, 10300);
  assert.equal(result.totalAccountDebitMinor, 10500);
  assert.equal(result.providerChargesMinor, 500);
  assert.equal(result.memberAmountPaidMinor, 10000);
});

test('organization fees are included before platform charges', () => {
  const result = calculateTransactionFees({
    direction: 'deposit', principalMinor: 10001,
    fees: {
      sacco: { basisPoints: 100 },
      xhenvolt: { basisPoints: 200 },
      marzpay: { basisPoints: 300 },
    },
  });
  assert.equal(result.saccoFeeMinor, 100);
  assert.equal(result.xhenvoltFeeMinor, 202);
  assert.equal(result.providerRequestedMinor, 10303);
  assert.equal(result.marzpayFeeMinor, 309);
  assert.equal(result.totalCustomerChargeMinor, 10612);
});

test('disabled fees, minimum and maximum fees, and half-up boundaries are explicit', () => {
  assert.equal(calculateTransactionFees({ direction: 'deposit', principalMinor: 100, fees: {
    xhenvolt: { enabled: false, basisPoints: 9999 },
    marzpay: { basisPoints: 50 },
  } }).marzpayFeeMinor, 1);
  assert.equal(calculateTransactionFees({ direction: 'deposit', principalMinor: 10000, fees: {
    sacco: { basisPoints: 1, minimumMinor: 5, maximumMinor: 8 },
  } }).saccoFeeMinor, 5);
  assert.equal(calculateTransactionFees({ direction: 'deposit', principalMinor: 100000, fees: {
    sacco: { basisPoints: 100, maximumMinor: 8 },
  } }).saccoFeeMinor, 8);
});

test('rejects invalid monetary values and percentages', () => {
  assert.throws(() => calculateTransactionFees({ direction: 'deposit', principalMinor: 1.5 }), /positive safe integer/);
  assert.throws(() => calculateTransactionFees({ direction: 'deposit', principalMinor: 1, fees: {
    xhenvolt: { basisPoints: 10001 },
  } }), /between 0 and 100 percent/);
  assert.throws(() => calculateTransactionFees({ direction: 'transfer', principalMinor: 1 }), /direction/);
});

test('combined provider percentages exclude disabled components', () => {
  assert.equal(combineProviderFeePercentages({
    xhenvolt: { basisPoints: 200 }, marzpay: { enabled: false, basisPoints: 300 },
  }), 200);
});
