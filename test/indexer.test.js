import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Indexer } from '../src/indexer.js';
import { GENESIS_HASH, MINT_ID } from '../src/config.js';
import { entry, transaction, event, pda, owner, u64, string, logs } from './helpers.js';

test('unavailable transaction stays queued while later events are indexed', async () => {
  const store = new Store(':memory:');
  try {
    const a = entry('unavailable', 2), b = entry('available', 1);
    store.enqueue([a, b]);
    const rpc = { batch: async requests => requests.map(r => r.params[0] === a.signature ? null : transaction(b)) };
    await new Indexer(store, rpc).process();
    assert.equal(store.pendingCount(), 1);
    assert.equal(store.status().unresolved, 1);
    assert.equal(store.list().events[0].signature, b.signature);
  } finally { store.close(); }
});
test('recent discovery preserves the previous head through multiple pages', async () => {
  const store = new Store(':memory:');
  try {
    store.set('head', 'old-head');
    const pages = [[entry('new-head', 4), entry('new-middle', 3)], [entry('new-last', 2), entry('old-head', 1)]];
    const indexer = new Indexer(store, { call: async () => pages.shift() });
    await indexer.recent();
    assert.equal(store.get('head'), 'old-head');
    assert.equal(store.get('recentScan').before, 'new-middle');
    await indexer.recent();
    assert.equal(store.get('head'), 'new-head');
    assert.equal(store.get('recentScan'), null);
    assert.equal(store.pendingCount(), 3);
  } finally { store.close(); }
});
test('discovery cursor and queued signatures survive reopening the cache', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'wxmr-explorer-test-'));
  let store = new Store(join(dir, 'cache.sqlite'));
  try {
    const indexer = new Indexer(store, { call: async () => [entry('newest', 3), entry('oldest', 1)] });
    await indexer.recent();
    store.close();
    store = new Store(join(dir, 'cache.sqlite'));
    assert.equal(store.get('head'), 'newest');
    assert.equal(store.get('backfill').before, 'oldest');
    assert.equal(store.pendingCount(), 2);
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});
test('missing history cursor and transaction identity mismatches are reported', async () => {
  const store = new Store(':memory:');
  try {
    store.set('head', 'missing');
    const indexer = new Indexer(store, { call: async () => [], batch: async () => [transaction(entry('wrong', 2))] });
    await assert.rejects(indexer.recent(), /cursor is missing/);
    assert.equal(store.get('head'), 'missing');
    assert.equal(store.get('historyGap'), true);
    store.enqueue([entry('expected', 1)]);
    await indexer.process();
    assert.equal(store.pendingCount(), 1);
    assert.equal(store.list().total, 0);
  } finally { store.close(); }
});
test('failed transactions never create activity', async () => {
  const store = new Store(':memory:');
  try {
    const e = entry('failed', 1);
    store.enqueue([e]);
    const tx = transaction(e); tx.meta.err = { InstructionError: [0, 'failure'] };
    await new Indexer(store, { batch: async () => [tx] }).process();
    assert.equal(store.list().total, 0);
    assert.equal(store.pendingCount(), 0);
  } finally { store.close(); }
});
test('reads finalized mint supply exactly and rejects malformed snapshots without replacing the last good value', async () => {
  const store = new Store(':memory:');
  try {
    let result = { context: { slot: 459333328 }, value: { amount: '9007199254740993', decimals: 12 } };
    const indexer = new Indexer(store, { call: async (method, params) => {
      assert.equal(method, 'getTokenSupply');
      assert.deepEqual(params, [MINT_ID, { commitment: 'finalized' }]);
      return result;
    } });
    await indexer.refreshSupply();
    assert.equal(store.status().supply.amount, '9007.199254740993');
    assert.equal(store.status().supply.slot, 459333328);
    for (const invalid of [
      { ...result, value: { amount: '1000', decimals: 9 } },
      { ...result, value: { amount: 9007199254740993, decimals: 12 } },
      { ...result, value: { amount: '18446744073709551616', decimals: 12 } },
      { ...result, context: { slot: 0 } },
    ]) {
      result = invalid;
      await assert.rejects(indexer.refreshSupply(), /Invalid finalized/);
      assert.equal(store.status().supply.amountAtomic, '9007199254740993');
    }
  } finally { store.close(); }
});
test('supply read failures remain visible while ordinary indexing continues', async () => {
  const store = new Store(':memory:');
  try {
    const e = entry('newest', 3);
    const rpc = {
      call: async (method, params) => {
        if (method === 'getGenesisHash') return GENESIS_HASH;
        if (method === 'getAccountInfo') return { value: { executable: true } };
        if (method === 'getTokenSupply') throw new Error('Helius RPC unavailable or timed out');
        if (method === 'getSignaturesForAddress') return params[1].before ? [] : [e];
        throw new Error('Unexpected RPC method');
      },
      batch: async () => [transaction(e)],
    };
    await new Indexer(store, rpc).tick();
    assert.equal(store.status().supply, null);
    assert.match(store.status().supplyError, /unavailable/);
    assert.equal(store.status().error, null);
    assert.equal(store.list().events[0].signature, e.signature);
  } finally { store.close(); }
});
test('upgrades an existing cache by replaying early deposits and withdrawal histories, preserving other audit work', async () => {
  const store = new Store(':memory:');
  try {
    const legacy = entry('legacy-deposit', 1), modern = entry('modern-deposit', 2);
    const request = entry('withdraw-request', 3), refund = entry('withdraw-refund', 4), audit = entry('audit', 5);
    store.enqueue([legacy, modern, request, refund, audit]);
    for (const e of [legacy, refund, audit]) store.save({ ...e, block_time: e.blockTime }, []);
    store.save({ ...modern, block_time: modern.blockTime }, [{ index: 1, type: 'mint', owner: 'wallet', pda: 'deposit', amountAtomic: '1000' }]);
    store.save({ ...request, block_time: request.blockTime }, [{ index: 1, type: 'withdraw', owner: 'wallet', pda: 'withdrawal', amountAtomic: '500' }]);
    const txs = {
      [legacy.signature]: transaction(legacy, logs(event('DepositCompletedEvent', [pda, owner, u64(123)]))),
      [request.signature]: transaction(request, []),
      [refund.signature]: transaction(refund, logs(event('WithdrawRevertedEvent', [pda, owner, u64(500), u64(5), string('Canceled by withdrawal owner')]))),
    };
    const rpc = { batch: async requests => requests.map(r => {
      if (r.method === 'getSignaturesForAddress') {
        assert.equal(r.params[0], 'withdrawal');
        return [refund, request, entry('unrelated-signature', 6)];
      }
      assert.ok(txs[r.params[0]], 'only early deposits and withdrawal history need reprocessing');
      return txs[r.params[0]];
    }) };
    const indexer = new Indexer(store, rpc);
    store.prepareEventBackfill();
    assert.equal(store.status().eventBackfillComplete, false);
    assert.deepEqual(store.pending().map(r => r.signature), [legacy.signature]);
    await indexer.process();
    await indexer.backfillRefunds();
    await indexer.process();
    assert.equal(store.pendingCount(), 0);
    assert.equal(store.status().eventBackfillComplete, true);
    assert.equal(store.stats()[3].depositedAtomic, '1123');
    assert.equal(store.stats()[3].refundedAtomic, '500');
    assert.equal(store.stats()[3].netFlow, '0.000000001123');
    assert.equal(store.list({ type: 'refund' }).total, 1);
    assert.equal(store.db.prepare('SELECT done FROM queue WHERE signature=?').get(audit.signature).done, 1);
    store.prepareEventBackfill();
    await indexer.backfillRefunds();
    assert.equal(store.pendingCount(), 0, 'completed upgrade does not repeat');
  } finally { store.close(); }
});
test('refund backfill survives restart and preserves its cursor when history is unavailable', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'wxmr-explorer-upgrade-'));
  let store = new Store(join(dir, 'cache.sqlite'));
  try {
    const e = entry('request', 2);
    store.enqueue([e]);
    store.save({ ...e, block_time: e.blockTime }, [{ index: 1, type: 'withdraw', owner: 'wallet', pda: 'record', amountAtomic: '1' }]);
    store.prepareEventBackfill();
    const cursor = store.get('eventBackfill');
    await assert.rejects(new Indexer(store, { batch: async () => { throw new Error('unavailable'); } }).backfillRefunds(), /unavailable/);
    assert.deepEqual(store.get('eventBackfill'), cursor);
    store.close();
    store = new Store(join(dir, 'cache.sqlite'));
    store.prepareEventBackfill();
    assert.deepEqual(store.get('eventBackfill'), cursor);
    await new Indexer(store, { batch: async () => [[e]] }).backfillRefunds();
    assert.equal(store.status().eventBackfillComplete, true);
    assert.equal(store.list({ type: 'withdraw' }).total, 1);
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});
