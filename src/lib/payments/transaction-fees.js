const COMPONENTS = ['sacco', 'xhenvolt', 'marzpay'];
const DIRECTIONS = ['deposit', 'withdrawal'];

function validateMinor(amount, label = 'amount') {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer in minor units`);
  }
}

function feeFor(baseMinor, rule = {}) {
  validateMinor(baseMinor, 'fee base');
  if (rule.enabled === false) return 0;
  const basisPoints = rule.basisPoints ?? 0;
  if (!Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > 10000) {
    throw new RangeError('Fee percentage must be between 0 and 100 percent');
  }
  let fee = Number((BigInt(baseMinor) * BigInt(basisPoints) + 5000n) / 10000n);
  if (rule.minimumMinor != null) {
    validateMinor(rule.minimumMinor, 'minimum fee');
    fee = Math.max(fee, rule.minimumMinor);
  }
  if (rule.maximumMinor != null) {
    validateMinor(rule.maximumMinor, 'maximum fee');
    if (rule.maximumMinor < (rule.minimumMinor ?? 0)) {
      throw new RangeError('Maximum fee cannot be lower than minimum fee');
    }
    fee = Math.min(fee, rule.maximumMinor);
  }
  return fee;
}

/**
 * Calculates a UGX payment preview using whole minor units and half-up rounding.
 * Deposit provider fees are payer-borne on the amount sent to MarzPay. On a
 * withdrawal, MarzPay deducts its fee from the organization wallet; the member
 * debit includes the same cost separately from the payout amount.
 */
export function calculateTransactionFees({ direction, principalMinor, fees = {}, configurationVersions = {} }) {
  if (!DIRECTIONS.includes(direction)) throw new TypeError('direction must be deposit or withdrawal');
  if (!Number.isSafeInteger(principalMinor) || principalMinor <= 0) {
    throw new TypeError('principalMinor must be a positive safe integer in minor units');
  }
  const rules = Object.fromEntries(COMPONENTS.map(component => [component, fees[component] || {}]));

  const saccoFeeMinor = feeFor(principalMinor, rules.sacco);
  const xhenvoltBaseMinor = principalMinor + saccoFeeMinor;
  const xhenvoltFeeMinor = feeFor(xhenvoltBaseMinor, rules.xhenvolt);
  const preGatewayMinor = xhenvoltBaseMinor + xhenvoltFeeMinor;
  const marzpayBaseMinor = direction === 'deposit' ? preGatewayMinor : principalMinor;
  const marzpayFeeMinor = feeFor(marzpayBaseMinor, rules.marzpay);
  const providerRequestedMinor = direction === 'deposit' ? preGatewayMinor : principalMinor;
  const memberTotalMinor = direction === 'deposit'
    ? providerRequestedMinor + marzpayFeeMinor
    : principalMinor + saccoFeeMinor + xhenvoltFeeMinor + marzpayFeeMinor;
  const walletSettlementMinor = direction === 'deposit'
    ? providerRequestedMinor
    : principalMinor + marzpayFeeMinor;

  for (const amount of [saccoFeeMinor, xhenvoltFeeMinor, marzpayFeeMinor,
    providerRequestedMinor, memberTotalMinor, walletSettlementMinor]) validateMinor(amount);

  return Object.freeze({
    currency: 'UGX',
    direction,
    principalMinor,
    saccoFeeMinor,
    xhenvoltFeeMinor,
    marzpayFeeMinor,
    transactionChargesMinor: saccoFeeMinor + xhenvoltFeeMinor + marzpayFeeMinor,
    totalCustomerChargeMinor: direction === 'deposit' ? memberTotalMinor : null,
    totalAccountDebitMinor: direction === 'withdrawal' ? memberTotalMinor : null,
    providerRequestedMinor,
    expectedWalletCreditMinor: direction === 'deposit' ? walletSettlementMinor : null,
    expectedWalletDeductionMinor: direction === 'withdrawal' ? walletSettlementMinor : null,
    memberAmountCreditedMinor: direction === 'deposit' ? principalMinor : null,
    memberAmountPaidMinor: direction === 'withdrawal' ? principalMinor : null,
    saccoRevenueMinor: saccoFeeMinor,
    xhenvoltRevenueMinor: xhenvoltFeeMinor,
    gatewayCostMinor: marzpayFeeMinor,
    configurationVersions: Object.freeze({ ...configurationVersions }),
    rounding: 'nearest minor unit, half up',
  });
}

export function combineProviderFeePercentages(config = {}) {
  return (config.xhenvolt?.enabled === false ? 0 : (config.xhenvolt?.basisPoints || 0)) +
    (config.marzpay?.enabled === false ? 0 : (config.marzpay?.basisPoints || 0));
}
