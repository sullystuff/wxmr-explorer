import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { restoreBootstrap } from '../src/bootstrap.js';

test('bootstrap restores history and cursors into missing, zero-byte, and schema-only databases', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wxmr-bootstrap-test-'));
  const source = new Store(':memory:');
  try {
    source.enqueue([{ signature: 'saved', slot: 123, blockTime: 1700000000, err: null }]);
    source.save({ signature: 'saved', slot: 123, block_time: 1700000000 }, [
      { index: 0, type: 'mint', owner: 'wallet', pda: 'record', amountAtomic: '100' },
    ], '5');
    source.set('head', 'saved');
    source.set('backfill', { before: 'oldest', exhausted: true });
    source.db.prepare('VACUUM INTO ?').run(join(directory, 'source.sqlite'));
    const archive = join(directory, 'source.sqlite.xz');
    writeFileSync(archive, execFileSync('xz', ['-9e', '-c', join(directory, 'source.sqlite')]));
    for (const kind of ['missing', 'zero-byte', 'schema-only']) {
      const path = join(directory, `${kind}.sqlite`);
      if (kind === 'zero-byte') writeFileSync(path, '');
      if (kind === 'schema-only') new Store(path).close();
      const store = new Store(path);
      try {
        restoreBootstrap(store, archive);
        assert.equal(store.list().total, 1);
        assert.equal(store.get('head'), 'saved');
        assert.deepEqual(store.get('backfill'), { before: 'oldest', exhausted: true });
        assert.equal(store.status().transactionsScanned, 1);
        assert.equal(store.list().events[0].feeDeltaAtomic, '5');
        store.set('head', 'newer');
        restoreBootstrap(store, '/does-not-exist.xz');
        assert.equal(store.get('head'), 'newer', 'existing history needs no archive');
      } finally { store.close(); }
    }
  } finally { source.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('queued-only databases are preserved and corrupt archives leave empty databases usable', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wxmr-bootstrap-test-'));
  const store = new Store(':memory:');
  try {
    const archive = join(directory, 'corrupt.xz');
    writeFileSync(archive, 'invalid');
    assert.throws(() => restoreBootstrap(store, archive));
    assert.equal(store.list().total, 0);
    store.enqueue([{ signature: 'pending', slot: 1, err: null }]);
    restoreBootstrap(store, archive);
    assert.equal(store.pendingCount(), 1);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
