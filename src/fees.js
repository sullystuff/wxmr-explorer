import { FEE_ACCOUNT_ID, MINT_ID } from './config.js';

// Measure the treasury once per successful deposit/withdrawal transaction.
// Old deposits that never included the treasury have an exact zero fee.
export function feeAccountDelta(tx) {
  const message = tx.transaction?.message;
  if (!Array.isArray(message?.accountKeys) || !tx.meta || tx.meta.err) throw new Error('Invalid fee transaction');
  const loaded = tx.meta?.loadedAddresses;
  if (message.addressTableLookups?.length && (!Array.isArray(loaded?.writable) || !Array.isArray(loaded?.readonly))) {
    throw new Error('Fee account lookup addresses unavailable; will retry');
  }
  const keys = [...message.accountKeys, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])];
  if (keys.some(key => typeof key !== 'string')) throw new Error('Invalid fee account keys');
  const index = keys.indexOf(FEE_ACCOUNT_ID);
  if (index === -1) return '0';

  const balance = (rows, lamports) => {
    if (!Array.isArray(rows)) throw new Error('Fee token balances unavailable; will retry');
    const matches = rows.filter(row => row.accountIndex === index);
    if (!matches.length && lamports?.[index] === 0) return 0n; // Created or closed token account.
    const row = matches[0];
    const amount = row?.uiTokenAmount?.amount;
    if (matches.length !== 1 || row.mint !== MINT_ID || row.uiTokenAmount?.decimals !== 12 ||
      typeof amount !== 'string' || !/^\d+$/.test(amount) || BigInt(amount) > 18446744073709551615n) {
      throw new Error('Invalid fee token balance; will retry');
    }
    return BigInt(amount);
  };
  const before = balance(tx.meta.preTokenBalances, tx.meta.preBalances);
  const after = balance(tx.meta.postTokenBalances, tx.meta.postBalances);
  return (after - before).toString();
}
