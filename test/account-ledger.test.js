import test from 'node:test';
import assert from 'node:assert/strict';
import { getAccountLedgerDelta } from '../src/lib/account-ledger.js';

test('a deposit increases the organization cash balance', () => {
  assert.equal(getAccountLedgerDelta('DEBIT', 1000, 'deposit'), 1000);
});

test('a withdrawal decreases the organization cash balance', () => {
  assert.equal(getAccountLedgerDelta('CREDIT', 1000, 'withdrawal'), -1000);
});

test('other transaction types retain existing account-entry sign mapping', () => {
  assert.equal(getAccountLedgerDelta('CREDIT', 1000, 'transfer'), -1000);
});

test('unsupported account ledger entry types are rejected', () => {
  assert.throws(() => getAccountLedgerDelta('OTHER', 1000), /Invalid account ledger entry type/);
});
