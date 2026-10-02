import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Indexer } from '../src/indexer.js';
import { entry, transaction } from './helpers.js';

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
