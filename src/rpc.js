import { setTimeout as delay } from 'node:timers/promises';

const METHODS = new Set(['getGenesisHash', 'getAccountInfo', 'getSignaturesForAddress', 'getTransaction']);

export class Rpc {
  constructor(url, interval = 300) {
    if (!url) throw new Error('Set SOLANA_RPC_URL in .env to your Helius endpoint');
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) throw new Error();
    } catch { throw new Error('SOLANA_RPC_URL must be a valid HTTPS endpoint'); }
    this.url = url;
    this.interval = interval;
    this.nextCall = 0;
    this.id = 0;
    this.controller = new AbortController();
  }
  async batch(requests) {
    if (!requests.length) return [];
    const payload = requests.map(({ method, params }) => {
      if (!METHODS.has(method)) throw new Error('RPC method is not read-only');
      return { jsonrpc: '2.0', id: ++this.id, method, params };
    });
    await delay(Math.max(0, this.nextCall - Date.now()), undefined, { signal: this.controller.signal });
    this.nextCall = Date.now() + this.interval;
    let response;
    try {
      response = await fetch(this.url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload.length === 1 ? payload[0] : payload),
        signal: AbortSignal.any([AbortSignal.timeout(20000), this.controller.signal]),
      });
    } catch { throw new Error('Helius RPC unavailable or timed out'); }
    // Never surface endpoint URLs or provider error bodies, which can contain credentials.
    if (!response.ok) throw new Error(`Helius RPC HTTP ${response.status}`);
    let body;
    try { body = await response.json(); } catch { throw new Error('Invalid Helius RPC response'); }
    const messages = Array.isArray(body) ? body : [body];
    return payload.map(request => {
      const message = messages.find(item => item.id === request.id);
      if (!message || message.error || !Object.hasOwn(message, 'result')) {
        throw new Error(`Helius RPC ${request.method} failed (code ${Number(message?.error?.code) || 'unknown'})`);
      }
      return message.result;
    });
  }
  async call(method, params = []) { return (await this.batch([{ method, params }]))[0]; }
  close() { this.controller.abort(); }
}
