import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { feesUsd, PriceFeed } from '../src/price.js';
import { MINT_ID } from '../src/config.js';

test('USD conversion rounds the exact total to cents without floating-point loss', () => {
  assert.equal(feesUsd('0', '596.87'), '0.00');
  assert.equal(feesUsd('1000000000000', '596.87'), '596.87');
  assert.equal(feesUsd('1234567890000', '596.87'), '736.88');
  assert.equal(feesUsd('5000000000', '1'), '0.01');
  assert.equal(feesUsd('4999999999', '1'), '0.00');
  assert.equal(feesUsd('1', '0.000000000000000001'), '0.00');
  assert.equal(feesUsd('9007199254740993000000000000', '1.01'), '9097271247288402.93');
  for (const price of [null, undefined, '', '0', 'NaN', 'Infinity', '-1', '1e3', 596.87]) {
    assert.equal(feesUsd('1', price), null);
  }
});

test('market quote uses the most liquid Solana pair with wXMR as its base token', async () => {
  const store = new Store(':memory:');
  const pair = { chainId: 'solana', baseToken: { address: MINT_ID }, pairAddress: 'deep-pool', priceUsd: '596.87', liquidity: { usd: 400000 } };
  let requests = 0;
  const feed = new PriceFeed(store, async (url, options) => {
    requests++;
    assert.equal(url, `https://api.dexscreener.com/token-pairs/v1/solana/${MINT_ID}`);
    assert.ok(options.signal instanceof AbortSignal);
    return { ok: true, json: async () => [
      { ...pair, baseToken: { address: 'another-token' }, quoteToken: { address: MINT_ID }, liquidity: { usd: 9000000 } },
      { ...pair, chainId: 'ethereum', liquidity: { usd: 9000000 } },
      { ...pair, priceUsd: '-1', liquidity: { usd: 9000000 } },
      { ...pair, liquidity: { usd: 0 } },
      { ...pair, pairAddress: 'small-pool', priceUsd: '600', liquidity: { usd: 1000 } },
      pair,
    ] };
  });
  try {
    await Promise.all([feed.poll(), feed.poll()]);
    await feed.poll();
    assert.equal(requests, 1, 'requests are shared and rate limited');
    assert.equal(store.status().price.usd, '596.87');
    assert.equal(store.status().price.pairAddress, 'deep-pool');
    assert.equal(store.status().price.stale, false);
    assert.equal(store.status().priceError, null);
  } finally { await feed.close(); store.close(); }
});

test('market failures retain the previous quote, mark it stale, and recover independently of indexing', async () => {
  const store = new Store(':memory:');
  let response = { ok: false };
  const feed = new PriceFeed(store, async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  try {
    const snapshot = { mint: MINT_ID, usd: '500', checkedAt: new Date().toISOString() };
    store.set('price', snapshot);
    for (const invalid of [
      { ok: false }, { ok: true, json: async () => ({ error: 'invalid response' }) },
      { ok: true, json: async () => [] }, new Error('Network unavailable'),
    ]) {
      response = invalid;
      await feed.refresh();
      assert.deepEqual(store.get('price'), snapshot);
      assert.equal(store.status().price.stale, true);
      assert.equal(store.status().error, null);
    }
    response = { ok: true, json: async () => [{ chainId: 'solana', baseToken: { address: MINT_ID }, pairAddress: 'pool', priceUsd: '510', liquidity: { usd: 400000 } }] };
    await feed.refresh();
    assert.equal(store.status().price.usd, '510');
    assert.equal(store.status().price.stale, false);
    assert.equal(store.status().priceError, null);
  } finally { await feed.close(); store.close(); }
});
