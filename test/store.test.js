import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';

const now = 1700000000000;
function save(store, signature, type, amountAtomic, secondsAgo, slot) {
  const entry = { signature, slot, blockTime: now / 1000 - secondsAgo, err: null };
  store.enqueue([entry]);
  store.save({ ...entry, block_time: entry.blockTime }, [{ index: 1, type, owner: 'wallet', pda: 'record', ...(amountAtomic ? { amountAtomic } : {}) }]);
}
test('volume windows have exact sums, exclude fees, and count creation separately', () => {
  const store = new Store(':memory:');
  try {
    save(store, 'recent-mint', 'mint', '9007199254740993', 60, 9);
    save(store, '8h-boundary', 'withdraw', '1', 8 * 3600, 8);
    save(store, 'older-mint', 'mint', '1000000000000', 8 * 3600 + 1, 7);
    save(store, 'day-old', 'withdraw', '500000000000', 24 * 3600 + 1, 6);
    save(store, 'week-old', 'mint', '2000000000000', 7 * 86400 + 1, 5);
    save(store, 'creation', 'create', null, 1, 10);
    const windows = Object.fromEntries(store.stats(now).map(s => [s.id, s]));
    assert.equal(windows['8h'].depositedAtomic, '9007199254740993');
    assert.equal(windows['8h'].withdrawnAtomic, '1');
    assert.equal(windows['8h'].creates, 1);
    assert.equal(windows['24h'].depositedAtomic, '9008199254740993');
    assert.equal(windows['24h'].withdrawnAtomic, '1');
    assert.equal(windows['7d'].withdrawnAtomic, '500000000001');
    assert.equal(windows.all.depositedAtomic, '9010199254740993');
    assert.equal(windows.all.deposits, 3);
    assert.equal(windows.all.withdrawals, 2);
  } finally { store.close(); }
});
test('deduplicates transaction events, searches full values, and paginates', () => {
  const store = new Store(':memory:');
  try {
    save(store, 'signature-one', 'mint', '1', 1, 1);
    save(store, 'signature-one', 'mint', '1', 1, 1);
    save(store, 'signature-two', 'withdraw', '2', 1, 2);
    save(store, 'hidden-refund', 'refund', '2', 1, 3);
    assert.equal(store.list().total, 2);
    assert.equal(store.list({ type: 'mint', search: 'signature-one' }).total, 1);
    assert.equal(store.list({ search: 'record' }).total, 2);
    assert.equal(store.list({ search: 'hidden-refund' }).total, 0);
    assert.equal(store.list({ type: 'refund' }).total, 0);
    assert.equal(store.list({ limit: 1 }).events[0].signature, 'signature-two');
    assert.equal(store.list({ limit: 1, offset: 1 }).events[0].signature, 'signature-one');
    assert.equal(store.stats(now)[0].deposits, 1);
  } finally { store.close(); }
});
test('refunds add back the burned net amount in the refund time window, without counting fees', () => {
  const store = new Store(':memory:');
  try {
    save(store, 'mint', 'mint', '9007199254740993', 10 * 3600, 1);
    save(store, 'requested', 'withdraw', '9007199254740993', 9 * 3600, 2);
    save(store, 'refunded', 'refund', '9007199254740993', 60, 3);
    save(store, 'refunded', 'refund', '9007199254740993', 60, 3);
    const windows = Object.fromEntries(store.stats(now).map(s => [s.id, s]));
    assert.equal(windows['8h'].depositedAtomic, '0');
    assert.equal(windows['8h'].withdrawnAtomic, '-9007199254740993');
    assert.equal(windows['8h'].withdrawn, '-9007.199254740993');
    assert.equal(windows['8h'].refundedAtomic, '9007199254740993');
    assert.equal(windows['8h'].netFlow, '9007.199254740993');
    assert.equal(windows.all.netFlow, '9007.199254740993');
    assert.equal(windows['24h'].withdrawnAtomic, '0');
    assert.equal(windows.all.withdrawnAtomic, '0');
    assert.equal(windows.all.withdrawn, '0');
    assert.equal(windows.all.refunds, 1);
    assert.equal(windows.all.deposits, 1);
    assert.equal(windows.all.withdrawals, 1);
    assert.equal(store.status().counts.refund, 1);
    assert.equal(store.list().total, 2);
  } finally { store.close(); }
});
test('cached supply becomes stale after a failed read or an expired snapshot', () => {
  const store = new Store(':memory:');
  try {
    const snapshot = { amountAtomic: '2424663609625448', amount: '2424.663609625448', checkedAt: new Date().toISOString() };
    store.set('supply', snapshot);
    assert.equal(store.status().supply.stale, false);
    store.set('supplyError', 'RPC unavailable');
    assert.equal(store.status().supply.stale, true);
    assert.equal(store.status().supply.amountAtomic, snapshot.amountAtomic);
    store.set('supplyError', null);
    store.set('supply', { ...snapshot, checkedAt: new Date(Date.now() - 61000).toISOString() });
    assert.equal(store.status().supply.stale, true);
  } finally { store.close(); }
});
test('event persistence and queue completion roll back together', () => {
  const store = new Store(':memory:');
  try {
    store.enqueue([{ signature: 'broken', slot: 1, blockTime: 1, err: null }]);
    assert.throws(() => store.save({ signature: 'broken', slot: 1, block_time: 1 }, [
      { index: 0, type: 'mint', owner: 'wallet', pda: 'record', amountAtomic: '1' },
      { index: 1, type: 'mint', owner: null, pda: 'record', amountAtomic: '2' },
    ]));
    assert.equal(store.list().total, 0);
    assert.equal(store.pendingCount(), 1);
  } finally { store.close(); }
});
