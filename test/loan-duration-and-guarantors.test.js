import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateLoan } from '../src/lib/loan-calculation.js';
import {
  resolveGuarantorRequirements,
  validateExternalGuarantor,
} from '../src/lib/loan-guarantor-rules.js';

test('loan calculation treats duration values in days, weeks, months, and years', () => {
  const dayLoan = calculateLoan({
    principal: 1200,
    interestRate: 12,
    duration: 14,
    durationUnit: 'DAYS',
    repaymentCycle: 'DAILY',
  });
  assert.equal(dayLoan.schedule.length, 14);
  assert.equal(dayLoan.totalInterest, 5.6);

  const weekLoan = calculateLoan({
    principal: 1200,
    interestRate: 10,
    duration: 4,
    durationUnit: 'WEEKS',
    repaymentCycle: 'WEEKLY',
  });
  assert.equal(weekLoan.schedule.length, 4);

  const yearLoan = calculateLoan({
    principal: 1200,
    interestRate: 10,
    duration: 1,
    durationUnit: 'YEARS',
    repaymentCycle: 'ANNUALLY',
  });
  assert.equal(yearLoan.schedule.length, 1);
  assert.equal(yearLoan.totalInterest, 120);
});

test('loan schedule installments sum exactly to rounded principal and interest', () => {
  const result = calculateLoan({
    principal: 1000.01,
    interestRate: 7.5,
    duration: 7,
    durationUnit: 'WEEKS',
    repaymentCycle: 'BIWEEKLY',
  });
  const principal = result.schedule.reduce((sum, item) => sum + item.principal_amount, 0);
  const interest = result.schedule.reduce((sum, item) => sum + item.interest_amount, 0);
  const total = result.schedule.reduce((sum, item) => sum + item.total_amount, 0);
  assert.equal(Math.round(principal * 100), 100001);
  assert.equal(Math.round(interest * 100), Math.round(result.totalInterest * 100));
  assert.equal(Math.round(total * 100), Math.round(result.totalPayable * 100));
});

test('loan duration and repayment cycle reject unsupported values', () => {
  assert.throws(() => calculateLoan({
    principal: 100,
    interestRate: 10,
    duration: 1,
    durationUnit: 'FORTNIGHTS',
  }), /Duration unit/);
  assert.throws(() => calculateLoan({
    principal: 100,
    interestRate: 10,
    duration: 1,
    repaymentCycle: 'FORTNIGHTLY',
  }), /repayment cycle/i);
});

test('guarantor requirements resolve legacy counts and configurable member scope', () => {
  assert.deepEqual(resolveGuarantorRequirements({ count: 3 }), {
    member_count: 3,
    external_count: 1,
    member_scope: 'SAME_GROUP',
    external_required_fields: [
      'full_name',
      'phone',
      'national_id',
      'physical_address',
      'occupation',
      'relationship',
    ],
  });
  assert.equal(
    resolveGuarantorRequirements({ member_scope: 'ANY_ORGANIZATION_MEMBER' }).member_scope,
    'ANY_ORGANIZATION_MEMBER'
  );
  assert.throws(
    () => resolveGuarantorRequirements({ member_scope: 'ANY_MEMBER' }),
    /member guarantor scope/i
  );
});

test('outside guarantor fields and guaranteed amount are validated', () => {
  const valid = {
    full_name: 'Outside Guarantor',
    phone: '+256700000000',
    national_id: 'ID-123',
    physical_address: 'Kampala',
    occupation: 'Farmer',
    relationship: 'Relative',
    guaranteed_amount: 250000,
  };
  assert.equal(validateExternalGuarantor(valid, ['full_name', 'phone']), null);
  assert.match(validateExternalGuarantor({ ...valid, phone: '' }, ['phone']), /Telephone is required/);
  assert.match(validateExternalGuarantor({ ...valid, guaranteed_amount: 0 }, []), /positive guaranteed amount/);
});
