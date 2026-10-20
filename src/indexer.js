import { PROGRAM_ID, MINT_ID, GENESIS_HASH, formatAmount } from './config.js';
import { decodeLogs } from './events.js';

export class Indexer {
  constructor(store, rpc, pollMs = 15000) {
    Object.assign(this, { store, rpc, pollMs });
    this.nextPoll = 0;
    this.nextSupplyPoll = 0;
    this.verified = false;
  }
  async verify() {
    if (await this.rpc.call('getGenesisHash') !== GENESIS_HASH) throw new Error('RPC is not Solana mainnet');
    const account = await this.rpc.call('getAccountInfo', [PROGRAM_ID, { commitment: 'finalized', encoding: 'base64' }]);
    if (!account?.value?.executable) throw new Error('wXMR bridge program is unavailable');
    this.verified = true;
  }
  async signatures(before, address = PROGRAM_ID) {
    const result = await this.rpc.call('getSignaturesForAddress', [address, {
      commitment: 'finalized', limit: 100, ...(before ? { before } : {}),
    }]);
    if (!Array.isArray(result)) throw new Error('Invalid signature history');
    return result;
  }
  async refreshSupply() {
    const result = await this.rpc.call('getTokenSupply', [MINT_ID, { commitment: 'finalized' }]);
    const amount = result?.value?.amount;
    if (result?.value?.decimals !== 12 || typeof amount !== 'string' || !/^\d+$/.test(amount) ||
      BigInt(amount) > 18446744073709551615n || !Number.isSafeInteger(result?.context?.slot) || result.context.slot < 1) {
      throw new Error('Invalid finalized wXMR supply');
    }
    this.store.set('supply', {
      mint: MINT_ID, amountAtomic: amount, amount: formatAmount(amount),
      slot: result.context.slot, checkedAt: new Date().toISOString(),
    });
    this.store.set('supplyError', null);
  }
  async backfillRefunds() {
    const cursor = this.store.get('eventBackfill');
    if (!cursor || cursor.exhausted || this.store.pendingCount() >= 75) return;
    const pdas = this.store.withdrawalRecords(cursor.afterPda);
    if (!pdas.length) { this.store.set('eventBackfill', { ...cursor, exhausted: true }); return; }
    const histories = await this.rpc.batch(pdas.map(pda => ({ method: 'getSignaturesForAddress', params: [pda, {
      commitment: 'finalized', limit: 100,
    }] })));
    const entries = [];
    for (const [i, history] of histories.entries()) {
      if (!Array.isArray(history)) throw new Error('Invalid withdrawal signature history');
      entries.push(...history);
      let page = history;
      while (page.length === 100) {
        const before = page.at(-1).signature;
        page = await this.signatures(before, pdas[i]);
        if (page.at(-1)?.signature === before) throw new Error('Withdrawal history pagination stalled');
        entries.push(...page);
      }
    }
    this.store.transaction(() => {
      // Only revisit transactions already discovered through the bridge program.
      // Never clear existing events: their IDs deduplicate the replay.
      this.store.requeueKnown(entries);
      this.store.set('eventBackfill', { afterPda: pdas.at(-1), exhausted: pdas.length < 25 });
    });
  }
  async recent() {
    const head = this.store.get('head');
    if (!head) {
      const page = await this.signatures();
      this.store.transaction(() => {
        this.store.enqueue(page);
        if (page.length) {
          this.store.set('head', page[0].signature);
          this.store.set('backfill', { before: page.at(-1).signature, exhausted: false });
        }
      });
      return;
    }
    const scan = this.store.get('recentScan') ?? { stop: head, before: null, newest: null };
    const page = await this.signatures(scan.before);
    if (!page.length) {
      this.store.set('historyGap', true);
      throw new Error('Saved history cursor is missing from RPC history; cursor preserved');
    }
    const stop = page.findIndex(entry => entry.signature === scan.stop);
    scan.newest ??= page[0].signature;
    this.store.transaction(() => {
      this.store.enqueue(stop >= 0 ? page.slice(0, stop) : page);
      if (stop >= 0) {
        this.store.set('head', scan.newest);
        this.store.set('recentScan', null);
        this.store.set('historyGap', false);
      } else {
        if (page.at(-1).signature === scan.before) throw new Error('RPC history pagination stalled');
        scan.before = page.at(-1).signature;
        this.store.set('recentScan', scan);
      }
    });
  }
  async backfill() {
    const cursor = this.store.get('backfill');
    if (!cursor || cursor.exhausted || this.store.pendingCount() >= 75) return;
    const page = await this.signatures(cursor.before);
    this.store.transaction(() => {
      this.store.enqueue(page, 1);
      if (page.length && page.at(-1).signature === cursor.before) throw new Error('RPC history pagination stalled');
      this.store.set('backfill', { before: page.at(-1)?.signature ?? cursor.before, exhausted: !page.length });
    });
  }
  async process() {
    const entries = this.store.pending();
    for (const entry of entries.filter(e => e.failed)) this.store.save(entry, []);
    const valid = entries.filter(e => !e.failed);
    if (!valid.length) return;
    const transactions = await this.rpc.batch(valid.map(entry => ({ method: 'getTransaction', params: [entry.signature, {
      commitment: 'finalized', encoding: 'json', maxSupportedTransactionVersion: 0,
    }] })));
    for (const [i, entry] of valid.entries()) {
      try {
        const tx = transactions[i];
        if (!tx?.meta) throw new Error('Finalized transaction unavailable; will retry');
        if (tx.slot !== entry.slot || tx.transaction?.signatures?.[0] !== entry.signature) throw new Error('Transaction identity mismatch');
        this.store.save({ ...entry, block_time: tx.blockTime ?? entry.block_time }, tx.meta.err ? [] : decodeLogs(tx.meta.logMessages));
      } catch (error) { this.store.defer(entry.signature, error.message); }
    }
  }
  async tick() {
    try {
      if (!this.verified) await this.verify();
      this.store.prepareEventBackfill();
      if (Date.now() >= this.nextSupplyPoll) {
        try { await this.refreshSupply(); }
        catch (error) { this.store.set('supplyError', error.message); }
        this.nextSupplyPoll = Date.now() + this.pollMs;
      }
      if (Date.now() >= this.nextPoll || this.store.get('recentScan')) {
        await this.recent();
        this.nextPoll = Date.now() + this.pollMs;
      }
      await this.process();
      await this.backfill();
      await this.backfillRefunds();
      this.store.set('lastSync', new Date().toISOString());
      this.store.set('error', null);
    } catch (error) {
      if (!this.rpc.controller?.signal.aborted) this.store.set('error', error.message);
      throw error;
    }
  }
}
