import { createHash } from 'node:crypto';
import { PROGRAM_ID } from '../src/config.js';

export const owner = Buffer.alloc(32, 2);
export const pda = Buffer.alloc(32, 3);
export function u64(n) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }
export function i64(n) { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; }
export function string(s) { const b = Buffer.from(s); const length = Buffer.alloc(4); length.writeUInt32LE(b.length); return Buffer.concat([length, b]); }
export function event(name, fields) {
  return Buffer.concat([createHash('sha256').update(`event:${name}`).digest().subarray(0, 8), ...fields]);
}
export function logs(bytes) { return [`Program ${PROGRAM_ID} invoke [1]`, `Program data: ${bytes.toString('base64')}`, `Program ${PROGRAM_ID} success`]; }
export function mint(amount = '9007199254740993') { return event('DepositMintedEvent', [pda, owner, u64(amount), u64(amount)]); }
export function entry(signature, slot, blockTime = 1700000000) { return { signature, slot, blockTime, err: null }; }
export function transaction(e, logMessages = logs(mint())) {
  return { slot: e.slot, blockTime: e.blockTime, transaction: { signatures: [e.signature] }, meta: { err: null, logMessages } };
}
