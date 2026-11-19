import test from 'node:test';
import assert from 'node:assert/strict';
import {
  postCompletedDisbursementLedger,
  postDisbursementVarianceAdjustment,
} from '../src/lib/payments/marzpay-disbursement-ledger.js';

function createFakePool({ failLedgerEntryOnce = false } = {}) {
  let shouldFailLedgerEntryOnce = failLedgerEntryOnce;
  const state = {
    intent: {
      id: 'a7d2165c-a113-46ac-a775-72ebd1d60e39',
      direction: 'disbursement',
      status: 'processing',
      ledger_status: 'pending',
      transaction_id: null,
      amount_minor: 1000,
      settlement_account_id: 'fa948c05-4d60-4bc3-8952-955bc10ddcda',
      member_account_id: '839cc544-3af8-4dd7-bafe-1c91ef80c597',
      provider_reference: 'fa3fca74-a2b9-4317-a650-4be05c1d9a14',
      provider_uuid: 'ba7151e2-247e-4472-b4b2-1c5a329a1e2e',
      created_by: 'e0e96a49-b052-42c8-8ed4-1cb9f33b70ea',
      organization_id: 'a7d2165c-a113-46ac-a775-72ebd1d60e38',
      reconciliation_adjustment_transaction_id: null,
      provider_amount_minor: 1050,
      provider_fee_minor: 0,
    },
    transactions: [],
    ledgerEntries: [],
    companyLedger: [],
  };

  const pool = {
    state,
    async query(sql, params) {
      if (sql.includes("SET ledger_status = 'failed'")) {
        state.intent.ledger_status = 'failed';
        state.intent.ledger_failure_reason = params[0];
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected pool query: ${sql}`);
    },
    async connect() {
      let snapshot = null;
      return {
        async query(sql, params = []) {
          if (sql === 'BEGIN') {
            snapshot = structuredClone(state);
            return { rows: [] };
          }
          if (sql === 'COMMIT') {
            snapshot = null;
            return { rows: [] };
          }
          if (sql === 'ROLLBACK') {
            if (snapshot) Object.assign(state, snapshot);
            snapshot = null;
            return { rows: [] };
          }
          if (sql.includes('FROM payment_intents') && sql.includes('FOR UPDATE')) {
            return { rows: [state.intent] };
          }
          if (sql.includes('FROM accounts') && sql.includes("type = 'system'")) {
            return { rows: params[0] === 'system-account' && params[1] === state.intent.organization_id ? [{ id: params[0] }] : [] };
          }
          if (sql.includes('INSERT INTO transactions')) {
            const id = `transaction-${state.transactions.length + 1}`;
            state.transactions.push({ id, params });
            return { rows: [{ id }] };
          }
          if (sql.includes('INSERT INTO ledger_entries')) {
            if (shouldFailLedgerEntryOnce) {
              shouldFailLedgerEntryOnce = false;
              throw new Error('simulated ledger insert failure');
            }
            state.ledgerEntries.push({ params });
            return { rows: [] };
          }
          if (sql.includes('INSERT INTO ledger')) {
            state.companyLedger.push({ params });
            return { rows: [] };
          }
          if (sql.includes("SET status = 'settled', ledger_status = 'posted'")) {
            state.intent.status = 'settled';
            state.intent.ledger_status = 'posted';
            state.intent.ledger_amount_minor = params[0];
            state.intent.transaction_id = params[1];
            state.intent.ledger_failure_reason = null;
            return { rowCount: 1, rows: [] };
          }
          if (sql.includes("SET reconciliation_status = 'adjusted'")) {
            state.intent.reconciliation_adjustment_transaction_id = params[0];
            state.intent.reconciliation_status = 'adjusted';
            return { rowCount: 1, rows: [] };
          }
          throw new Error(`Unexpected client query: ${sql}`);
        },
        release() {},
      };
    },
  };
  return pool;
}

for (const [description, providerTransaction] of [
  ['completed with missing currency', { status: 'completed', amountMinor: 1000, currency: null }],
  ['completed with missing amount', { status: 'completed', amountMinor: null, currency: 'UGX' }],
  ['completed with a different provider amount', { status: 'completed', amountMinor: 970, currency: 'UGX' }],
]) {
  test(`posts requested amount exactly once when provider is ${description}`, async () => {
    const pool = createFakePool();
    const result = await postCompletedDisbursementLedger(
      pool.state.intent.id,
      providerTransaction,
      pool
    );

    assert.equal(result.ledgerStatus, 'posted');
    assert.equal(pool.state.intent.ledger_amount_minor, 1000);
    assert.equal(pool.state.ledgerEntries.length, 2);
    assert.equal(pool.state.ledgerEntries[0].params[2], 1000);
  });
}

test('duplicate webhook reconciliation does not post the withdrawal ledger twice', async () => {
  const pool = createFakePool();
  const completed = { status: 'completed', amountMinor: 1000, currency: 'UGX' };

  const first = await postCompletedDisbursementLedger(pool.state.intent.id, completed, pool);
  const duplicate = await postCompletedDisbursementLedger(pool.state.intent.id, completed, pool);

  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(pool.state.transactions.length, 1);
  assert.equal(pool.state.ledgerEntries.length, 2);
  assert.equal(pool.state.companyLedger.length, 1);
});

test('a failed ledger write rolls back and retries to one completed posting', async () => {
  const pool = createFakePool({ failLedgerEntryOnce: true });
  const completed = { status: 'completed', amountMinor: 1000, currency: null };

  await assert.rejects(
    postCompletedDisbursementLedger(pool.state.intent.id, completed, pool),
    /simulated ledger insert failure/
  );
  assert.equal(pool.state.intent.ledger_status, 'failed');
  assert.equal(pool.state.transactions.length, 0);
  assert.equal(pool.state.ledgerEntries.length, 0);

  const retry = await postCompletedDisbursementLedger(pool.state.intent.id, completed, pool);
  assert.equal(retry.ledgerStatus, 'posted');
  assert.equal(pool.state.intent.ledger_amount_minor, 1000);
  assert.equal(pool.state.transactions.length, 1);
  assert.equal(pool.state.ledgerEntries.length, 2);
});

test('does not post the ledger before MarzPay completion', async () => {
  const pool = createFakePool();

  await assert.rejects(
    postCompletedDisbursementLedger(
      pool.state.intent.id,
      { status: 'processing', amountMinor: 1000, currency: 'UGX' },
      pool
    ),
    /must confirm completion/
  );
  assert.equal(pool.state.transactions.length, 0);
  assert.equal(pool.state.ledgerEntries.length, 0);
});

test('variance adjustments are balanced, organization-scoped, immutable, and idempotent', async () => {
  const pool = createFakePool();
  await postCompletedDisbursementLedger(
    pool.state.intent.id,
    { status: 'completed', amountMinor: 1000, currency: 'UGX' },
    pool
  );

  const input = {
    intentId: pool.state.intent.id,
    varianceMinor: 50,
    reconciliationAccountId: 'system-account',
    pool,
  };
  const first = await postDisbursementVarianceAdjustment(input);
  const duplicate = await postDisbursementVarianceAdjustment(input);

  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(pool.state.intent.reconciliation_status, 'adjusted');
  assert.equal(pool.state.transactions.length, 2);
  assert.equal(pool.state.ledgerEntries.length, 4);
  assert.equal(pool.state.ledgerEntries[2].params[2], 'CREDIT');
  assert.equal(pool.state.ledgerEntries[3].params[2], 'DEBIT');
  assert.equal(pool.state.ledgerEntries[2].params[3], 50);
  assert.equal(pool.state.ledgerEntries[3].params[3], 50);
});
