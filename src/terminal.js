import { emitKeypressEvents } from 'node:readline';
import { TYPES } from './config.js';

const short = (s, width) => s.length <= width ? s : `${s.slice(0, width - 5)}…${s.slice(-4)}`;
const pad = (s, width) => short(String(s), width).padEnd(width);
const time = value => value === null ? 'Unknown' : new Date(value * 1000).toISOString().slice(5, 19).replace('T', ' ');
const color = (code, value) => `\x1b[${code}m${value}\x1b[0m`;

export function printEvents(events, output = process.stdout) {
  for (const event of events) {
    output.write(`${time(event.blockTime)} UTC  ${TYPES[event.type].label}  ${event.amount === null ? '' : `${event.amount} ${event.type === 'mint' ? 'wXMR' : 'XMR'}`}\n`);
    output.write(`  Wallet: ${event.owner}\n  Record: ${event.pda}\n  Tx: ${event.txUrl}\n`);
  }
}

export function terminal(store, options, stop, following = false) {
  let type = options.type || '';
  let search = options.search || '';
  let editing = false;
  let page = 0;
  let selected = 0;
  let details = false;
  let lastRows = [];
  const out = process.stdout;
  out.write('\x1b[?1049h\x1b[?25l');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  emitKeypressEvents(process.stdin);

  function render() {
    const width = Math.max(40, out.columns || 100);
    const pageSize = Math.max(1, (out.rows || 30) - 17);
    const status = store.status();
    const result = store.list({ type, search, limit: pageSize, offset: page * pageSize });
    lastRows = result.events;
    selected = Math.min(selected, Math.max(0, lastRows.length - 1));
    const lines = [
      color('1;38;5;208', 'wXMR / bridge explorer') + color('90', `  mainnet · finalized${following ? ' · following local indexer' : ''}`),
      color('90', 'Deposit volumes = minted wXMR · withdrawal volumes = net XMR requested'),
      '',
      color('1', `${pad('VOLUME', 15)}${pad('DEPOSITS', 23)}${pad('WITHDRAWALS', 23)}NET FLOW`),
      ...store.stats().map(window => `${pad(window.label, 15)}${pad(`${window.deposited} (${window.deposits})`, 23)}${pad(`${window.withdrawn} (${window.withdrawals})`, 23)}${window.netFlow}`),
      '',
      `Addresses created: ${status.counts.create}  ·  Mints: ${status.counts.mint}  ·  Requests: ${status.counts.withdraw}`,
    ];
    if (details && lastRows[selected]) {
      const event = lastRows[selected];
      lines.push('', color('1', TYPES[event.type].label), `Time: ${time(event.blockTime)} UTC · slot ${event.slot}`,
        `Amount: ${event.amount === null ? '—' : `${event.amount} ${event.type === 'mint' ? 'wXMR' : 'XMR'}`}`,
        `Wallet: ${event.owner}`, `Record: ${event.pda}`, `Signature: ${event.signature}`, `Solscan: ${event.txUrl}`);
      if (event.xmrAddress) lines.push(`XMR destination: ${event.xmrAddress}`, `Fee (atomic): ${event.feeAtomic}`);
      lines.push('', 'Esc / Enter: back to activity');
    } else {
      const small = width < 90;
      const amountWidth = Math.min(26, Math.max(18, width - (small ? 40 : 72)));
      lines.push(color('1', `  ${pad('TIME (UTC)', 15)}${pad('EVENT', 24)}${pad('AMOUNT', amountWidth)}${small ? '' : `${pad('WALLET', 18)}TRANSACTION`}`));
      for (const [i, event] of lastRows.entries()) {
        const amount = event.amount === null ? '—' : `${event.amount} ${event.type === 'mint' ? 'wXMR' : 'XMR'}`;
        const line = `${i === selected ? '› ' : '  '}${pad(time(event.blockTime), 15)}${pad(TYPES[event.type].label, 24)}${pad(amount, amountWidth)}${small ? '' : `${pad(event.owner, 18)}${short(event.signature, Math.max(12, width - 59 - amountWidth))}`}`;
        lines.push(i === selected ? color('38;5;208', line) : line);
      }
      if (!lastRows.length) lines.push(color('90', status.pending ? 'Loading bridge activity…' : 'No matching events indexed yet.'));
      while (lines.length < (out.rows || 30) - 4) lines.push('');
      lines.push(`Page ${page + 1} · ${result.total} matching events · ${type ? TYPES[type].label : 'All events'}${search ? ` · search: ${search}` : ''}`);
    }
    const coverage = status.historyExhausted && !status.pending && !status.historyGap ? 'RPC history indexed' : 'History indexing; volumes cover indexed events';
    lines.push(color('90', `${coverage} · ${status.transactionsScanned} tx scanned · ${status.pending} queued${status.unresolved ? ` · ${status.unresolved} awaiting retry` : ''}`));
    lines.push(status.error ? color('31', status.error) : color('90', `Last sync: ${status.lastSync ? new Date(status.lastSync).toLocaleTimeString() : 'connecting…'}`));
    lines.push(editing ? `Search: ${search}█  (Enter to apply / Esc to clear)` : color('90', '0 all · 1 create · 2 mint · 3 withdraw · / search · n/p page · ↑↓ select · Enter details · q quit'));
    out.write(`\x1b[H\x1b[2J${lines.slice(0, out.rows || 40).join('\n')}`);
  }

  function onKey(str, key = {}) {
    if (key.ctrl && key.name === 'c') { stop(); return; }
    if (editing) {
      if (key.name === 'return') editing = false;
      else if (key.name === 'escape') { editing = false; search = ''; }
      else if (key.name === 'backspace') search = search.slice(0, -1);
      else if (str && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(str)) search += str;
      page = 0;
    } else if (details) {
      if (key.name === 'escape' || key.name === 'return') details = false;
      if (str === 'q') stop();
    } else {
      if (str === 'q') { stop(); return; }
      if ('0123'.includes(str) && str) { type = { 0: '', 1: 'create', 2: 'mint', 3: 'withdraw' }[str]; page = 0; }
      if (str === '/') { editing = true; search = ''; }
      if (str === 'n' && (page + 1) * Math.max(1, (out.rows || 30) - 17) < store.list({ type, search, limit: 1 }).total) { page++; selected = 0; }
      if (str === 'p') { page = Math.max(0, page - 1); selected = 0; }
      if (key.name === 'down') selected = Math.min(lastRows.length - 1, selected + 1);
      if (key.name === 'up') selected = Math.max(0, selected - 1);
      if (key.name === 'return') details = true;
    }
    render();
  }
  process.stdin.on('keypress', onKey);
  out.on('resize', render);
  const interval = setInterval(render, 1000);
  render();
  return () => {
    clearInterval(interval);
    out.off('resize', render);
    process.stdin.off('keypress', onKey);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    out.write('\x1b[?25h\x1b[?1049l');
  };
}
