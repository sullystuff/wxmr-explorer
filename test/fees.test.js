import test from 'node:test';
import assert from 'node:assert/strict';
import { feeAccountDelta } from '../src/fees.js';
import { FEE_ACCOUNT_ID, MINT_ID } from '../src/config.js';

const balance = (accountIndex, amount, mint = MINT_ID) => ({
  accountIndex, mint, uiTokenAmount: { amount, decimals: 12, uiAmount: Number(amount) / 1e12 },
});
function tx(before = '3884276729797', after = '3886144229797') {
  return {
    transaction: { message: { accountKeys: ['other-token-account', FEE_ACCOUNT_ID] } },
    meta: {
      err: null, preBalances: [2039280, 2039280], postBalances: [2039280, 2039280],
      preTokenBalances: [balance(0, '999999999999999'), balance(1, before)],
      postTokenBalances: [balance(1, after), balance(0, '1000000000000000')],
    },
  };
}
test('measures only the treasury account in atomic units, independent of token balance order and float precision', () => {
  // Mainnet deposit WZejqgbH…: 1.8675 gross, 1.8656325 to user, .0018675 to treasury.
  assert.equal(feeAccountDelta(tx()), '1867500000');
  assert.equal(feeAccountDelta(tx('9007199254740993', '9007199254741000')), '7');
  assert.equal(feeAccountDelta(tx('100', '100')), '0');
  assert.equal(feeAccountDelta(tx('100', '0')), '-100');
});
test('deposits before treasury activation have zero fees without assuming a percentage or activation date', () => {
  const legacy = tx();
  legacy.transaction.message.accountKeys = ['user-token-account', 'bridge-config'];
  legacy.meta.preTokenBalances = [];
  legacy.meta.postTokenBalances = [balance(0, '1110000000000')];
  assert.equal(feeAccountDelta(legacy), '0');
});
test('resolves treasury indices in versioned lookup table addresses and rejects incomplete lookups', () => {
  const versioned = tx();
  versioned.transaction.message.accountKeys.pop();
  versioned.transaction.message.addressTableLookups = [{ accountKey: 'lookup-table', writableIndexes: [0], readonlyIndexes: [] }];
  assert.throws(() => feeAccountDelta(versioned), /lookup addresses unavailable/);
  versioned.meta.loadedAddresses = { writable: [FEE_ACCOUNT_ID], readonly: [] };
  assert.equal(feeAccountDelta(versioned), '1867500000');
  versioned.meta.loadedAddresses = { writable: [], readonly: [FEE_ACCOUNT_ID] };
  assert.equal(feeAccountDelta(versioned), '1867500000');
});
test('recognizes treasury account creation and closure from lamport balances', () => {
  const created = tx('0', '1867500000');
  created.meta.preBalances[1] = 0;
  created.meta.preTokenBalances.pop();
  assert.equal(feeAccountDelta(created), '1867500000');
  const closed = tx('1867500000', '0');
  closed.meta.postBalances[1] = 0;
  closed.meta.postTokenBalances.shift();
  assert.equal(feeAccountDelta(closed), '-1867500000');
});
test('does not substitute zero for missing or malformed treasury balance metadata', () => {
  for (const change of [
    value => { delete value.meta.preTokenBalances; },
    value => { delete value.meta.postTokenBalances; },
    value => { value.meta.preTokenBalances.pop(); },
    value => { value.meta.postTokenBalances.shift(); },
    value => { value.meta.postTokenBalances[0].mint = 'different-mint'; },
    value => { value.meta.postTokenBalances[0].uiTokenAmount.decimals = 9; },
    value => { value.meta.postTokenBalances[0].uiTokenAmount.amount = 100; },
    value => { value.meta.postTokenBalances[0].uiTokenAmount.amount = '18446744073709551616'; },
    value => { value.meta.preTokenBalances.push(balance(1, '0')); },
    value => { value.meta.err = { InstructionError: [0, 'failure'] }; },
  ]) {
    const invalid = tx();
    change(invalid);
    assert.throws(() => feeAccountDelta(invalid), /fee|Fee/);
  }
});
