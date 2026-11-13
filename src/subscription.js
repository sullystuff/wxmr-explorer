import WebSocket from 'ws';
import bs58 from 'bs58';
import { PROGRAM_ID } from './config.js';

// Notifications discover signatures only. HTTP still supplies transaction identity,
// timestamps and token balances; the persisted history head advances only via RPC.
export class SignatureSubscription {
  constructor(rpcUrl, wsUrl, { createSocket = url => new WebSocket(url, {
    handshakeTimeout: 10000, maxPayload: 1024 * 1024, perMessageDeflate: false,
  }) } = {}) {
    try {
      const url = new URL(wsUrl || rpcUrl);
      if (!wsUrl && url.protocol === 'https:') url.protocol = 'wss:';
      if (url.protocol !== 'wss:' || url.username || url.password || url.hash) throw new Error();
      this.url = url.href;
    } catch { throw new Error('SOLANA_WS_URL must be a valid WSS endpoint'); }
    this.createSocket = createSocket;
    this.ready = false;
    this.revision = 0;
    this.retryMs = 1000;
  }
  start(onSignature) {
    if (this.started || this.stopped) return;
    this.started = true;
    this.onSignature = onSignature;
    this.connect();
  }
  connect() {
    if (this.stopped) return;
    let socket;
    try { socket = this.createSocket(this.url); }
    catch { this.reconnect(); return; }
    this.socket = socket;
    // Also time out a server that opens the socket but never acknowledges us.
    this.deadline = setTimeout(() => this.disconnect(socket), 20000);
    socket.on('open', () => {
      if (this.socket !== socket) return;
      try {
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'logsSubscribe',
          params: [{ mentions: [PROGRAM_ID] }, { commitment: 'finalized' }] }));
      } catch { this.disconnect(socket); }
    });
    socket.on('message', data => {
      if (this.socket !== socket) return;
      try {
        const message = JSON.parse(data.toString());
        if (message.id === 1) {
          if (this.ready || message.error || !Number.isSafeInteger(message.result) || message.result < 0) throw new Error();
          this.subscriptionId = message.result;
          this.ready = true;
          this.revision++;
          clearTimeout(this.deadline);
          this.alive = true;
          this.heartbeat = setInterval(() => {
            if (!this.alive) { this.disconnect(socket); return; }
            this.alive = false;
            try { socket.ping(); } catch { this.disconnect(socket); }
          }, 30000);
          return;
        }
        if (!this.ready || message.method !== 'logsNotification' || message.params?.subscription !== this.subscriptionId) return;
        const result = message.params.result;
        const { signature, err } = result.value;
        const slot = result.context?.slot;
        if (!Number.isSafeInteger(slot) || slot < 1 || typeof signature !== 'string' || signature.length > 88 ||
          bs58.decode(signature).length !== 64 || !Object.hasOwn(result.value, 'err')) throw new Error();
        this.onSignature({ signature, slot, err, blockTime: null });
      } catch {
        // Do not expose provider messages or URLs: they may contain credentials.
        // Reconnecting also makes the indexer reconcile any notification we lost.
        this.disconnect(socket);
      }
    });
    socket.on('pong', () => {
      if (this.socket === socket) {
        this.alive = true;
        this.retryMs = 1000;
      }
    });
    socket.on('error', () => this.disconnect(socket));
    socket.on('close', () => this.disconnect(socket));
  }
  disconnect(socket) {
    if (this.socket !== socket) return;
    this.socket = null;
    this.ready = false;
    this.revision++;
    clearTimeout(this.deadline);
    clearInterval(this.heartbeat);
    socket.terminate();
    this.reconnect();
  }
  reconnect() {
    if (this.stopped) return;
    this.retry = setTimeout(() => this.connect(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, 60000);
  }
  close() {
    this.stopped = true;
    this.ready = false;
    clearTimeout(this.retry);
    clearTimeout(this.deadline);
    clearInterval(this.heartbeat);
    const socket = this.socket;
    this.socket = null;
    socket?.terminate();
  }
}
