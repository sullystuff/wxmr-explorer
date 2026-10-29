import { MINT_ID } from './config.js';

export const PRICE_MAX_AGE_MS = 5 * 60000;
const validPrice = value => typeof value === 'string' && /^\d{1,18}(?:\.\d{1,18})?$/.test(value) && BigInt(value.replace('.', '')) > 0n;

// Convert the exact atomic sum to cents, rounding only the final USD value.
export function feesUsd(amountAtomic, price) {
  if (!validPrice(price)) return null;
  const [whole, fraction = ''] = price.split('.');
  const scale = 1000000000000n * 10n ** BigInt(fraction.length);
  const cents = (BigInt(amountAtomic) * BigInt(whole + fraction) * 100n + scale / 2n) / scale;
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
}

export class PriceFeed {
  constructor(store, fetchPrice = fetch) {
    Object.assign(this, { store, fetchPrice });
    this.controller = new AbortController();
    this.nextPoll = 0;
  }
  poll() {
    if (this.pending) return this.pending;
    if (this.controller.signal.aborted || Date.now() < this.nextPoll) return Promise.resolve();
    this.nextPoll = Date.now() + 60000;
    this.pending = this.refresh().finally(() => { this.pending = null; });
    return this.pending;
  }
  async refresh() {
    try {
      const response = await this.fetchPrice(`https://api.dexscreener.com/token-pairs/v1/solana/${MINT_ID}`, {
        signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(10000)]),
      });
      if (!response.ok) throw new Error();
      const pairs = await response.json();
      const pair = Array.isArray(pairs) && pairs.filter(pair => pair?.chainId === 'solana' &&
        pair.baseToken?.address === MINT_ID && typeof pair.pairAddress === 'string' &&
        validPrice(pair.priceUsd) && Number.isFinite(pair.liquidity?.usd) && pair.liquidity.usd > 0)
        .sort((a, b) => b.liquidity.usd - a.liquidity.usd)[0];
      if (!pair) throw new Error();
      this.store.set('price', {
        mint: MINT_ID, usd: pair.priceUsd, source: 'DEX Screener', pairAddress: pair.pairAddress,
        checkedAt: new Date().toISOString(),
      });
      this.store.set('priceError', null);
    } catch {
      if (!this.controller.signal.aborted) this.store.set('priceError', 'wXMR USD price unavailable; retrying');
    }
  }
  async close() {
    this.controller.abort();
    await this.pending;
  }
}
