import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { Store } from '../src/store.js';
import { terminal } from '../src/terminal.js';

test('terminal filters the selected wallet and event type from details, paginates, and clears back to global statistics', () => {
  const store = new Store(':memory:');
  const input = new PassThrough();
  input.setRawMode = () => {};
  const output = new PassThrough();
  output.rows = 30;
  output.columns = 180;
  let screen = '';
  output.on('data', data => { screen = data.toString().replace(/\x1b\[[\d;?]*[mHJhl]/g, ''); });
  let cleanup;
  try {
    for (const [signature, owner, type, slot] of [['a', 'wallet', 'withdraw', 3], ['b', 'wallet', 'withdraw', 1], ['c', 'wallet-extra', 'withdraw', 2], ['d', 'wallet', 'mint', 0]]) {
      const entry = { signature, slot, blockTime: Math.floor(Date.now() / 1000), err: null };
      store.enqueue([entry]);
      store.save({ ...entry, block_time: entry.blockTime }, [{ index: 0, type, owner, pda: 'record', amountAtomic: '1000000000000' }], '0');
    }
    const press = (str, name) => input.emit('keypress', str, { name });
    cleanup = terminal(store, {}, () => {}, false, { input, output });
    assert.match(screen, /4 matching events/);
    press('', 'return');
    assert.match(screen, /Wallet: wallet\n/);
    press('w', 'w');
    assert.match(screen, /wallet statistics/);
    assert.match(screen, /2 matching events · Withdraw request · wallet: wallet/);
    assert.doesNotMatch(screen, /wallet-extra/);
    press('n', 'n');
    assert.match(screen, /Page 2 · 2 matching events/);
    press('n', 'n');
    assert.match(screen, /Page 2 · 2 matching events/);
    press('2', '2');
    assert.match(screen, /Page 1 · 1 matching events · Mint deposit · wallet: wallet/);
    press('c', 'c');
    assert.doesNotMatch(screen, /wallet statistics/);
    press('3', '3');
    assert.match(screen, /3 matching events/);
  } finally {
    cleanup?.();
    input.destroy();
    output.destroy();
    store.close();
  }
});
