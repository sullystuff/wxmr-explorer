import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { web } from '../src/web.js';

test('wallet API filters activity and returns wallet statistics alongside global statistics', async () => {
  const store = new Store(':memory:');
  let server;
  try {
    for (const [signature, owner, type] of [['a', 'wallet', 'withdraw'], ['b', 'wallet', 'mint'], ['c', 'wallet-extra', 'withdraw']]) {
      const entry = { signature, slot: 1, blockTime: Math.floor(Date.now() / 1000), err: null };
      store.enqueue([entry]);
      store.save({ ...entry, block_time: entry.blockTime }, [{ index: 0, type, owner, pda: 'record', amountAtomic: '1000000000000' }], '100');
    }
    server = await web(store, { host: '127.0.0.1', port: 0 });
    const get = path => fetch(`http://127.0.0.1:${server.address().port}${path}`);
    const events = await (await get('/api/events?owner=wallet&type=withdraw')).json();
    assert.equal(events.total, 1);
    assert.equal(events.events[0].signature, 'a');
    const status = await (await get('/api/status?owner=wallet')).json();
    assert.equal(status.wallet.owner, 'wallet');
    assert.equal(status.wallet.stats[3].withdrawals, 1);
    assert.equal(status.wallet.stats[3].deposits, 1);
    assert.equal(status.stats[3].withdrawals, 2);
    assert.equal((await (await get('/api/status')).json()).wallet, undefined);
    assert.equal((await get(`/api/events?owner=${'a'.repeat(201)}`)).status, 400);
    assert.equal((await get(`/api/status?owner=${'a'.repeat(201)}`)).status, 400);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    store.close();
  }
});
