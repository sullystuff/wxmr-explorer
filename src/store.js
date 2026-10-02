import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { PROGRAM_ID, GENESIS_HASH, formatAmount } from './config.js';

export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS queue (
        ordinal INTEGER PRIMARY KEY AUTOINCREMENT, signature TEXT UNIQUE NOT NULL,
        slot INTEGER NOT NULL, block_time INTEGER, failed INTEGER NOT NULL,
        done INTEGER NOT NULL DEFAULT 0, priority INTEGER NOT NULL DEFAULT 0,
        retry_at INTEGER NOT NULL DEFAULT 0, error TEXT
      );
      CREATE INDEX IF NOT EXISTS pending ON queue(done, retry_at, priority, slot);
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, signature TEXT NOT NULL,
        slot INTEGER NOT NULL, log_index INTEGER NOT NULL, block_time INTEGER,
        owner TEXT NOT NULL, pda TEXT NOT NULL, amount_atomic TEXT, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS event_order ON events(slot DESC, signature, log_index DESC);
      CREATE INDEX IF NOT EXISTS event_type ON events(type, slot DESC);
    `);
    const identity = `${GENESIS_HASH}:${PROGRAM_ID}`;
    if (this.get('identity') && this.get('identity') !== identity) throw new Error('Cache belongs to another bridge');
    this.set('identity', identity);
  }
  get(key) {
    const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key);
    return row ? JSON.parse(row.value) : null;
  }
  set(key, value) { this.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(key, JSON.stringify(value)); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  enqueue(entries, priority = 0) {
    const statement = this.db.prepare(`INSERT INTO queue(signature,slot,block_time,failed,priority) VALUES (?,?,?,?,?)
      ON CONFLICT(signature) DO UPDATE SET priority=MIN(queue.priority,excluded.priority)`);
    for (const entry of entries) {
      if (typeof entry.signature !== 'string' || !Number.isSafeInteger(entry.slot)) throw new Error('Invalid signature history');
      statement.run(entry.signature, entry.slot, entry.blockTime ?? null, entry.err ? 1 : 0, priority);
    }
  }
  pending(limit = 25) {
    return this.db.prepare('SELECT * FROM queue WHERE done=0 AND retry_at<=? ORDER BY priority,slot DESC,ordinal ASC LIMIT ?').all(Date.now(), limit);
  }
  pendingCount() { return this.db.prepare('SELECT count(*) AS n FROM queue WHERE done=0').get().n; }
  defer(signature, error) {
    this.db.prepare('UPDATE queue SET retry_at=?,error=? WHERE signature=?').run(Date.now() + 60000, error, signature);
  }
  save(entry, events) {
    this.transaction(() => {
      const insert = this.db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING');
      for (const event of events) {
        insert.run(`${entry.signature}:${event.index}`, event.type, entry.signature, entry.slot, event.index,
          entry.block_time ?? null, event.owner, event.pda, event.amountAtomic ?? null, JSON.stringify(event));
      }
      this.db.prepare('UPDATE queue SET done=1,error=NULL WHERE signature=?').run(entry.signature);
    });
    this.statsCache = null;
  }
  list({ type = '', search = '', limit = 50, offset = 0 } = {}) {
    const clauses = [];
    const params = [];
    if (type) { clauses.push('type=?'); params.push(type); }
    if (search) {
      clauses.push('(instr(owner,?)>0 OR instr(signature,?)>0 OR instr(pda,?)>0 OR instr(data,?)>0)');
      params.push(search, search, search, search);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const total = this.db.prepare(`SELECT count(*) AS n FROM events ${where}`).get(...params).n;
    const rows = this.db.prepare(`SELECT * FROM events ${where} ORDER BY slot DESC,signature,log_index DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset);
    return { total, events: rows.map(row => ({
      ...JSON.parse(row.data), id: row.id, signature: row.signature, slot: row.slot,
      blockTime: row.block_time, amount: row.amount_atomic === null ? null : formatAmount(row.amount_atomic),
      txUrl: `https://solscan.io/tx/${row.signature}`,
    })) };
  }
  status() {
    const counts = { create: 0, mint: 0, withdraw: 0 };
    for (const row of this.db.prepare('SELECT type,count(*) AS n FROM events GROUP BY type').all()) counts[row.type] = row.n;
    return {
      programId: PROGRAM_ID, network: 'mainnet-beta', commitment: 'finalized', counts,
      pending: this.pendingCount(),
      unresolved: this.db.prepare('SELECT count(*) AS n FROM queue WHERE done=0 AND error IS NOT NULL').get().n,
      transactionsScanned: this.db.prepare('SELECT count(*) AS n FROM queue WHERE done=1').get().n,
      oldestIndexedTime: this.db.prepare('SELECT min(block_time) AS n FROM queue WHERE done=1').get().n,
      historyExhausted: this.get('backfill')?.exhausted ?? false,
      lastSync: this.get('lastSync'), error: this.get('error'), historyGap: this.get('historyGap'),
    };
  }
  stats(now = Date.now()) {
    const interval = Math.floor(now / 5000);
    const version = this.db.prepare('PRAGMA data_version').get().data_version;
    if (this.statsCache && this.statsCache.interval === interval && this.statsCache.version === version) return this.statsCache.value;
    const windows = [
      ['8h', '8 hours', 8 * 3600], ['24h', '24 hours', 24 * 3600],
      ['7d', '7 days', 7 * 86400], ['all', 'All indexed', null],
    ].map(([id, label, seconds]) => ({
      id, label, from: seconds === null ? null : Math.floor(now / 1000) - seconds,
      creates: 0, deposits: 0, withdrawals: 0, deposited: 0n, withdrawn: 0n,
    }));
    for (const row of this.db.prepare('SELECT type,amount_atomic,block_time FROM events').all()) {
      for (const window of windows) {
        if (window.from !== null && (row.block_time === null || row.block_time < window.from || row.block_time > now / 1000)) continue;
        if (row.type === 'create') window.creates++;
        if (row.type === 'mint') { window.deposits++; window.deposited += BigInt(row.amount_atomic); }
        if (row.type === 'withdraw') { window.withdrawals++; window.withdrawn += BigInt(row.amount_atomic); }
      }
    }
    const value = windows.map(window => ({
      id: window.id, label: window.label, from: window.from,
      creates: window.creates, deposits: window.deposits, withdrawals: window.withdrawals,
      depositedAtomic: window.deposited.toString(), withdrawnAtomic: window.withdrawn.toString(),
      deposited: formatAmount(window.deposited), withdrawn: formatAmount(window.withdrawn),
      netFlow: formatAmount(window.deposited - window.withdrawn),
    }));
    this.statsCache = { interval, version, value };
    return value;
  }
  close() { this.db.close(); }
}
