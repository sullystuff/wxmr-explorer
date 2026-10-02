import { resolve } from 'node:path';

export const PROGRAM_ID = 'EzBkC8P5wxab9kwrtV5hRdynHAfB5w3UPcPXNgMseVA8';
export const GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
export const TYPES = {
  create: { event: 'DepositAccountCreatedEvent', label: 'Deposit address created' },
  mint: { event: 'DepositMintedEvent', label: 'Mint deposit' },
  withdraw: { event: 'WithdrawRequestedEvent', label: 'Withdraw request' },
};

export function config(env = process.env) {
  const integer = (key, fallback, min, max) => {
    const n = Number(env[key] ?? fallback);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Invalid ${key}`);
    return n;
  };
  return {
    rpcUrl: env.SOLANA_RPC_URL,
    dataDir: resolve(env.DATA_DIR || './data'),
    pollMs: integer('POLL_INTERVAL_MS', 15000, 1000, 3600000),
    rpcMs: integer('RPC_INTERVAL_MS', 300, 100, 60000),
    host: env.HOST || '127.0.0.1',
    port: integer('PORT', 3100, 1, 65535),
  };
}

// Keep all amounts in piconero strings / BigInt, including display formatting.
export function formatAmount(value) {
  if (value === null || value === undefined) return '—';
  const raw = BigInt(value);
  const n = raw < 0n ? -raw : raw;
  const whole = (n / 1000000000000n).toString();
  const fraction = (n % 1000000000000n).toString().padStart(12, '0').replace(/0+$/, '');
  return `${raw < 0n ? '-' : ''}${fraction ? `${whole}.${fraction}` : whole}`;
}
