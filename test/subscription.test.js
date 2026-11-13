import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import bs58 from 'bs58';
import { SignatureSubscription } from '../src/subscription.js';
import { PROGRAM_ID } from '../src/config.js';

class Socket extends EventEmitter {
  sent = [];
  pings = 0;
  terminated = false;
  send(data) { this.sent.push(JSON.parse(data)); }
  ping() { this.pings++; }
  terminate() { this.terminated = true; this.emit('close'); }
  message(data) { this.emit('message', Buffer.from(JSON.stringify(data))); }
}
const signature = bs58.encode(Buffer.alloc(64, 2));
const notification = (subscription = 42, value = { signature, err: null, logs: [] }) => ({
  jsonrpc: '2.0', method: 'logsNotification',
  params: { subscription, result: { context: { slot: 123 }, value } },
});
function setup(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const sockets = [], entries = [];
  const feed = new SignatureSubscription('https://mainnet.helius-rpc.com/?api-key=secret', undefined, {
    createSocket: () => { const socket = new Socket(); sockets.push(socket); return socket; },
  });
  t.after(() => feed.close());
  feed.start(entry => entries.push(entry));
  return { feed, sockets, entries };
}
function acknowledge(socket) {
  socket.emit('open');
  socket.message({ jsonrpc: '2.0', id: 1, result: 42 });
}

test('derives a WSS endpoint and validates overrides without exposing credentials', () => {
  const feed = new SignatureSubscription('https://mainnet.helius-rpc.com/?api-key=secret');
  assert.equal(feed.url, 'wss://mainnet.helius-rpc.com/?api-key=secret');
  assert.equal(new SignatureSubscription('https://rpc.example', 'wss://ws.example/path?key=secret').url,
    'wss://ws.example/path?key=secret');
  for (const url of ['http://example.com/secret', 'ws://example.com', 'wss://user:secret@example.com', 'wss://example.com/#secret']) {
    assert.throws(() => new SignatureSubscription('https://rpc.example', url), {
      message: 'SOLANA_WS_URL must be a valid WSS endpoint',
    });
  }
});

test('subscribes once to finalized bridge logs and queues only its acknowledged subscription', t => {
  const { feed, sockets, entries } = setup(t);
  feed.start(() => assert.fail('must retain the original callback'));
  assert.equal(sockets.length, 1);
  const socket = sockets[0];
  socket.emit('open');
  assert.deepEqual(socket.sent, [{ jsonrpc: '2.0', id: 1, method: 'logsSubscribe',
    params: [{ mentions: [PROGRAM_ID] }, { commitment: 'finalized' }] }]);
  assert.equal(feed.ready, false);
  socket.message(notification());
  assert.equal(entries.length, 0);
  socket.message({ jsonrpc: '2.0', id: 1, result: 42 });
  assert.equal(feed.ready, true);
  socket.message(notification(99));
  assert.equal(entries.length, 0);
  socket.message(notification());
  socket.message(notification(42, { signature, err: { InstructionError: [0, 'failure'] } }));
  assert.deepEqual(entries, [
    { signature, slot: 123, err: null, blockTime: null },
    { signature, slot: 123, err: { InstructionError: [0, 'failure'] }, blockTime: null },
  ]);
});

test('rejected subscriptions back off, resubscribe and ignore messages from the old socket', t => {
  const { feed, sockets, entries } = setup(t);
  sockets[0].emit('open');
  sockets[0].message({ id: 1, error: { message: 'provider secret' } });
  assert.equal(feed.ready, false);
  assert.equal(sockets[0].terminated, true);
  t.mock.timers.tick(1000);
  assert.equal(sockets.length, 2);
  sockets[1].emit('error', new Error('provider secret'));
  t.mock.timers.tick(1000);
  assert.equal(sockets.length, 2);
  t.mock.timers.tick(1000);
  assert.equal(sockets.length, 3);
  acknowledge(sockets[2]);
  const revision = feed.revision;
  sockets[0].message(notification());
  sockets[0].emit('error', new Error('late error'));
  assert.equal(entries.length, 0);
  assert.equal(feed.ready, true);
  assert.equal(feed.revision, revision);
  sockets[2].message(notification());
  assert.equal(entries.length, 1);
});

test('times out sockets that never open or acknowledge the subscription', t => {
  const { feed, sockets } = setup(t);
  t.mock.timers.tick(20000);
  assert.equal(sockets[0].terminated, true);
  assert.equal(feed.ready, false);
  t.mock.timers.tick(1000);
  sockets[1].emit('open');
  t.mock.timers.tick(20000);
  assert.equal(sockets[1].terminated, true);
  assert.equal(feed.ready, false);
});

test('pings idle connections and reconnects when pong replies stop', t => {
  const { feed, sockets } = setup(t);
  acknowledge(sockets[0]);
  t.mock.timers.tick(30000);
  assert.equal(sockets[0].pings, 1);
  sockets[0].emit('pong');
  t.mock.timers.tick(30000);
  assert.equal(sockets[0].pings, 2);
  assert.equal(feed.ready, true);
  t.mock.timers.tick(30000);
  assert.equal(feed.ready, false);
  assert.equal(sockets[0].terminated, true);
  t.mock.timers.tick(1000);
  acknowledge(sockets[1]);
  assert.equal(feed.ready, true);
});

test('malformed notifications trigger recovery instead of entering the queue', t => {
  const { feed, sockets, entries } = setup(t);
  acknowledge(sockets[0]);
  sockets[0].message(notification(42, { signature: 'invalid-signature', err: null }));
  assert.equal(entries.length, 0);
  assert.equal(feed.ready, false);
  t.mock.timers.tick(1000);
  acknowledge(sockets[1]);
  const message = notification();
  message.params.result.context.slot = -1;
  sockets[1].message(message);
  assert.equal(entries.length, 0);
  assert.equal(feed.ready, false);
});

test('shutdown clears timers and prevents late notifications and reconnects', t => {
  const { feed, sockets, entries } = setup(t);
  acknowledge(sockets[0]);
  feed.close();
  sockets[0].message(notification());
  feed.start(() => assert.fail('closed feed restarted'));
  t.mock.timers.tick(120000);
  assert.equal(feed.ready, false);
  assert.equal(sockets[0].terminated, true);
  assert.equal(sockets[0].pings, 0);
  assert.equal(sockets.length, 1);
  assert.equal(entries.length, 0);
});
