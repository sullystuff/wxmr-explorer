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
    data.feeAtomic = reader.u64();
    data.xmrAddress = reader.string();
    data.exactOut = reader.bool();
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
