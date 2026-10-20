import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { config, ACTIVITY_TYPES } from './config.js';
import { Store } from './store.js';
import { Rpc } from './rpc.js';
import { Indexer } from './indexer.js';
import { acquireLock } from './lock.js';
import { terminal, printEvents, supplyLine } from './terminal.js';
import { web } from './web.js';

const help = `wXMR bridge explorer — terminal by default, no listening port

  npm start                         Live terminal dashboard
  npm start -- --type mint           Start with mint filter
  npm start -- --search ADDRESS      Filter by wallet, record, destination or tx
  npm start -- --json                Stream newly indexed events as JSONL
  npm run web                       Optional browser UI at localhost:3100
  npm run sync -- --passes 8         Bounded history sync (25 tx per pass)
  npm run events -- --limit 50       Print cached activity, no RPC calls
  npm run events -- --json           Cached activity as JSON
  npm start -- stats --json          Cached 8h / 24h / 7d / all volumes

Types: create, mint, withdraw (or all). Node.js 22.13+ required.
Keyboard: 0/1/2/3 filters, / search, n/p pages, ↑↓ select, Enter details, q quit.
Volumes: minted deposits and net withdrawals; indexed history only.
On-chain supply is read independently at finalized commitment.
Helius URL goes in the ignored .env as SOLANA_RPC_URL.
`;

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, json: { type: 'boolean' },
    type: { type: 'string' }, search: { type: 'string' },
    limit: { type: 'string', default: '50' }, passes: { type: 'string', default: '8' },
  } });
  if (values.help) { console.log(help); return; }
  const command = positionals[0] || 'live';
  if (!['live', 'web', 'sync', 'events', 'stats'].includes(command) || positionals.length > 1) throw new Error('Unknown command; use --help');
  const type = values.type === 'all' ? '' : values.type || '';
  if (type && !ACTIVITY_TYPES.includes(type)) throw new Error('Type must be create, mint, withdraw or all');
  const limit = Number(values.limit);
  const passes = Number(values.passes);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isInteger(passes) || passes < 1 || passes > 10000) throw new Error('Invalid limit or passes');
  const settings = config();
  const store = new Store(join(settings.dataDir, 'explorer.sqlite'));
  let release, rpc, server, cleanup;
  let stopping = false;
  const controller = new AbortController();
  const stop = () => {
    stopping = true;
    controller.abort();
    rpc?.close();
  };
  try {
    if (command === 'events') {
      const result = store.list({ type, search: values.search || '', limit });
      if (values.json) console.log(JSON.stringify(result, null, 2));
      else { printEvents(result.events); console.log(`${result.events.length} of ${result.total} cached events`); }
      return;
    }
    if (command === 'stats') {
      if (values.json) console.log(JSON.stringify({ stats: store.stats(), status: store.status() }, null, 2));
      else {
        console.log(supplyLine(store.status()));
        for (const window of store.stats()) console.log(`${window.label}: deposits ${window.deposited} wXMR · net withdrawals ${window.withdrawn} XMR · indexed net flow ${window.netFlow} XMR`);
      }
      return;
    }
    release = acquireLock(settings.dataDir);
    if (release) rpc = new Rpc(settings.rpcUrl, settings.rpcMs);
    const indexer = rpc ? new Indexer(store, rpc, settings.pollMs) : null;
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    if (command === 'sync') {
      if (!indexer) throw new Error('Another explorer is already indexing this cache');
      for (let i = 0; i < passes && !stopping; i++) await indexer.tick();
      console.log(JSON.stringify({ status: store.status(), stats: store.stats() }, null, 2));
      return;
    }
    const interactive = command === 'live' && !values.json && process.stdout.isTTY && process.stdin.isTTY;
    if (command === 'web') {
      server = await web(store, settings);
      console.log(`wXMR explorer: http://${settings.host}:${settings.port}${indexer ? '' : ' (following local indexer)'}`);
    } else if (interactive) cleanup = terminal(store, { type, search: values.search }, stop, !indexer);
    let seen = new Set(store.list({ limit: 200 }).events.map(e => e.id));
    let reportedError = '';
    let initial = true;
    while (!stopping) {
      if (indexer) {
        try { await indexer.tick(); reportedError = ''; }
        catch (error) {
          if (stopping) break;
          if (!interactive && error.message !== reportedError) console.error(error.message);
          reportedError = error.message;
        }
      }
      if (command === 'live' && !interactive) {
        const rows = store.list({ type, search: values.search || '', limit: 200 }).events;
        const fresh = rows.filter(e => initial || !seen.has(e.id));
        for (const event of fresh.reverse()) {
          if (values.json) console.log(JSON.stringify(event));
          else printEvents([event]);
        }
        seen = new Set([...seen, ...rows.map(e => e.id)]);
        initial = false;
      }
      try { await delay(reportedError ? 15000 : 1000, undefined, { signal: controller.signal }); }
      catch { break; }
    }
  } finally {
    cleanup?.();
    if (server) await new Promise(resolve => server.close(resolve));
    rpc?.close();
    release?.();
    store.close();
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

main().catch(error => { console.error(`Explorer: ${error.message}`); process.exitCode = 1; });
