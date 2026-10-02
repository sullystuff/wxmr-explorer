import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import { decodeEvent, decodeLogs } from '../src/events.js';
import { formatAmount, PROGRAM_ID } from '../src/config.js';
import { owner, pda, u64, i64, string, event, logs, mint } from './helpers.js';

test('decodes only the three requested events and ignores address assignment', () => {
  const created = decodeEvent(event('DepositAccountCreatedEvent', [pda, owner, i64(1700000000)]));
  assert.equal(created.type, 'create');
  assert.equal(created.owner, bs58.encode(owner));
  assert.equal(created.timestamp, '1700000000');
  assert.equal(decodeEvent(event('DepositAddressAssignedEvent', [pda, string('ignored')])), null);
  const withdrawal = decodeEvent(event('WithdrawRequestedEvent', [pda, owner, u64(12), u64(5500000000000), u64(100), string('xmr-destination'), Buffer.from([1]), i64(1700000001)]));
  assert.equal(withdrawal.type, 'withdraw');
  assert.equal(withdrawal.amountAtomic, '5500000000000');
  assert.equal(withdrawal.feeAtomic, '100');
  assert.equal(withdrawal.xmrAddress, 'xmr-destination');
  assert.equal(withdrawal.exactOut, true);
});
test('preserves amounts above float precision and formats negative net flow exactly', () => {
  assert.equal(decodeEvent(mint()).amountAtomic, '9007199254740993');
  assert.equal(formatAmount('9007199254740993'), '9007.199254740993');
  assert.equal(formatAmount('18446744073709551615'), '18446744.073709551615');
  assert.equal(formatAmount('-1'), '-0.000000000001');
  assert.equal(formatAmount('1000000000000'), '1');
});
test('decodes source-verified legacy withdrawal layouts without guessing missing fields', () => {
  const common = [pda, owner, u64(7), u64('9007199254740993'), string('8'.repeat(95))];
  const exact = decodeEvent(event('WithdrawRequestedEvent', [...common, Buffer.from([0]), i64(1700000000)]));
  assert.equal(exact.amountAtomic, '9007199254740993');
  assert.equal(exact.feeAtomic, null);
  assert.equal(exact.exactOut, false);
  const original = decodeEvent(event('WithdrawRequestedEvent', [...common, i64(1700000000)]));
  assert.equal(original.feeAtomic, null);
  assert.equal(original.exactOut, null);
  assert.equal(original.timestamp, '1700000000');
  const modern = event('WithdrawRequestedEvent', [pda, owner, u64(7), u64(1), u64(95), string('8'.repeat(95)), Buffer.from([0]), i64(1700000000)]);
  assert.throws(() => decodeEvent(modern.subarray(0, -8)), /Truncated/);
});
test('verifies program provenance and successful CPI ancestry', () => {
  const other = '11111111111111111111111111111111';
  const data = logs(mint())[1];
  assert.deepEqual(decodeLogs([`Program ${other} invoke [1]`, data, `Program ${other} success`]), []);
  const nested = [`Program ${other} invoke [1]`, `Program ${PROGRAM_ID} invoke [2]`, data];
  assert.equal(decodeLogs([...nested, `Program ${PROGRAM_ID} success`, `Program ${other} success`]).length, 1);
  assert.deepEqual(decodeLogs([...nested, `Program ${PROGRAM_ID} failed: custom program error: 1`, `Program ${other} success`]), []);
  assert.deepEqual(decodeLogs([...nested, `Program ${PROGRAM_ID} success`, `Program ${other} failed: custom program error: 1`]), []);
});
test('retains undecodable transactions by rejecting truncated logs and changed layouts', () => {
  assert.throws(() => decodeLogs(logs(mint()).slice(0, 2)), /Incomplete/);
  assert.throws(() => decodeLogs([...logs(mint()), 'Log truncated']), /truncated/);
  assert.throws(() => decodeEvent(mint().subarray(0, -1)), /Truncated/);
  assert.throws(() => decodeEvent(Buffer.concat([mint(), Buffer.from([0])])), /schema changed/);
});
