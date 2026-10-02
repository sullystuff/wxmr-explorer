import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import { PROGRAM_ID, TYPES } from './config.js';

const definitions = Object.entries(TYPES).map(([type, definition]) => ({
  type, ...definition,
  discriminator: createHash('sha256').update(`event:${definition.event}`).digest().subarray(0, 8),
}));

class Reader {
  constructor(bytes) { this.bytes = bytes; this.offset = 8; }
  take(n) {
    if (this.offset + n > this.bytes.length) throw new Error('Truncated bridge event');
    const value = this.bytes.subarray(this.offset, this.offset + n);
    this.offset += n;
    return value;
  }
  key() { return bs58.encode(this.take(32)); }
  u64() { return this.take(8).readBigUInt64LE().toString(); }
  i64() { return this.take(8).readBigInt64LE().toString(); }
  string() { return new TextDecoder('utf-8', { fatal: true }).decode(this.take(this.take(4).readUInt32LE())); }
  bool() {
    const value = this.take(1)[0];
    if (value > 1) throw new Error('Invalid bridge event boolean');
    return value === 1;
  }
}

export function decodeEvent(bytes) {
  if (bytes.length < 8) throw new Error('Truncated bridge event');
  const definition = definitions.find(d => bytes.subarray(0, 8).equals(d.discriminator));
  // Only the three requested events are decoded or persisted.
  if (!definition) return null;
  const reader = new Reader(bytes);
  const data = { pda: reader.key(), owner: reader.key() };
  if (definition.type === 'create') data.timestamp = reader.i64();
  if (definition.type === 'mint') {
    data.amountAtomic = reader.u64();
    data.totalDepositedAtomic = reader.u64();
  }
  if (definition.type === 'withdraw') {
    data.nonce = reader.u64();
    data.amountAtomic = reader.u64();
    // Historical layouts in bridge source: 1b90572 (no fee/exact_out),
    // 5ab4e32 (exact_out), 11e955b onward (fee + exact_out).
    const layout = [
      { fee: true, exactOut: true }, { fee: false, exactOut: true }, { fee: false, exactOut: false },
    ].find(candidate => {
      const offset = reader.offset + (candidate.fee ? 8 : 0);
      if (bytes.length < offset + 4) return false;
      const length = bytes.readUInt32LE(offset);
      if (bytes.length !== offset + 4 + length + (candidate.exactOut ? 1 : 0) + 8) return false;
      if (!candidate.fee) {
        // Prevent truncated modern data from masquerading as a legacy string.
        const address = bytes.subarray(offset + 4, offset + 4 + length).toString('ascii');
        return [95, 106].includes(length) && /^[1-9A-HJ-NP-Za-km-z]+$/.test(address);
      }
      return true;
    });
    if (!layout) throw new Error('Truncated or changed withdrawal event');
    data.feeAtomic = layout.fee ? reader.u64() : null;
    data.xmrAddress = reader.string();
    data.exactOut = layout.exactOut ? reader.bool() : null;
    data.timestamp = reader.i64();
  }
  if (reader.offset !== bytes.length) throw new Error('Bridge event schema changed');
  return { type: definition.type, ...data };
}

export function decodeLogs(logs) {
  if (!Array.isArray(logs)) throw new Error('Transaction logs unavailable');
  const stack = [];
  const events = [];
  for (const [index, line] of logs.entries()) {
    if (/log truncated/i.test(line)) throw new Error('Transaction logs truncated');
    const invoke = /^Program (\w+) invoke \[(\d+)\]$/.exec(line);
    if (invoke) {
      if (Number(invoke[2]) !== stack.length + 1) throw new Error('Incomplete transaction logs');
      stack.push({ program: invoke[1], events: [] });
      continue;
    }
    const end = /^Program (\w+) (success|failed:.*)$/.exec(line);
    if (end) {
      const frame = stack.pop();
      if (!frame || frame.program !== end[1]) throw new Error('Incomplete transaction logs');
      if (end[2] === 'success') (stack.at(-1)?.events ?? events).push(...frame.events);
      continue;
    }
    if (line.startsWith('Program data: ') && stack.at(-1)?.program === PROGRAM_ID) {
      const event = decodeEvent(Buffer.from(line.slice(14), 'base64'));
      if (event) stack.at(-1).events.push({ index, ...event });
    }
  }
  if (stack.length) throw new Error('Incomplete transaction logs');
  return events;
}
