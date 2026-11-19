export function getAccountLedgerDelta(entryType, amount, transactionType) {
  if (!['DEBIT', 'CREDIT'].includes(entryType)) {
    throw new TypeError(`Invalid account ledger entry type: ${entryType}`);
  }
  if (transactionType === 'deposit') return amount;
  if (transactionType === 'withdrawal') return -amount;
  if (entryType === 'DEBIT') return amount;
  if (entryType === 'CREDIT') return -amount;
  throw new TypeError(`Invalid account ledger entry type: ${entryType}`);
}
