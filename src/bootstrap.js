import { execFileSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BOOTSTRAP_PATH = fileURLToPath(new URL('../bootstrap/explorer.sqlite.xz', import.meta.url));

// Import under SQLite's writer lock so simultaneous startups cannot replace history.
export function restoreBootstrap(store, archive = BOOTSTRAP_PATH) {
  const empty = () => !store.db.prepare(`SELECT
    EXISTS(SELECT 1 FROM queue) OR EXISTS(SELECT 1 FROM events) OR
    EXISTS(SELECT 1 FROM transaction_fees) AS populated`).get().populated;
  if (!empty()) return;
  const directory = mkdtempSync(join(tmpdir(), 'wxmr-bootstrap-'));
  let attached = false;
  try {
    const snapshot = join(directory, 'explorer.sqlite');
    const fd = openSync(snapshot, 'wx', 0o600);
    try { execFileSync('xz', ['-dc', '--', archive], { stdio: ['ignore', fd, 'pipe'] }); }
    finally { closeSync(fd); }
    store.db.prepare('ATTACH DATABASE ? AS bootstrap').run(snapshot);
    attached = true;
    if (store.db.prepare('PRAGMA bootstrap.quick_check').get().quick_check !== 'ok') {
      throw new Error('Invalid bootstrap database');
    }
    const identity = store.db.prepare("SELECT value FROM bootstrap.meta WHERE key='identity'").get();
    if (!identity || JSON.parse(identity.value) !== store.get('identity')) throw new Error('Bootstrap belongs to another bridge');
    store.transaction(() => {
      if (!empty()) return;
      store.db.exec(`DELETE FROM meta;
        INSERT INTO meta SELECT * FROM bootstrap.meta;
        INSERT INTO queue SELECT * FROM bootstrap.queue;
        INSERT INTO events SELECT * FROM bootstrap.events;
        INSERT INTO transaction_fees SELECT * FROM bootstrap.transaction_fees;`);
    });
  } finally {
    if (attached) store.db.exec('DETACH DATABASE bootstrap');
    rmSync(directory, { recursive: true, force: true });
  }
}
