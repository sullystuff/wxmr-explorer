const labels = { create: 'Deposit address created', mint: 'Mint deposit', withdraw: 'Withdraw request', refund: 'Withdrawal refunded' };
let period = '24h';
let type = '';
let search = '';
let offset = 0;
let generation = 0;
let status;
let timer;
const $ = id => document.getElementById(id);
const short = value => `${value.slice(0, 10)}…${value.slice(-6)}`;
const integer = value => Number(value).toLocaleString();

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function link(text, url, title) {
  const element = node('a', text);
  element.href = url;
  element.target = '_blank';
  element.rel = 'noreferrer';
  if (title) element.title = title;
  return element;
}
function renderStats() {
  const stats = status?.stats.find(window => window.id === period);
  if (!stats) return;
  $('deposited').textContent = stats.deposited;
  $('withdrawn').textContent = stats.withdrawn;
  $('net-flow').textContent = stats.netFlow;
  $('creates').textContent = integer(stats.creates);
  $('deposit-count').textContent = `${integer(stats.deposits)} mints · wXMR`;
  $('withdraw-count').textContent = `${integer(stats.withdrawals)} requests · XMR`;
  $('refund-summary').textContent = `${stats.refunded} wXMR refunded in ${integer(stats.refunds)} reversals. Indexed net flow = minted − requested + refunded; burns outside the bridge can make it differ from supply.`;
  const supply = status.supply;
  $('supply').textContent = supply?.amount ?? '—';
  $('supply-status').textContent = supply ? `${supply.stale ? 'Stale · ' : ''}Finalized slot ${integer(supply.slot)} · checked ${new Date(supply.checkedAt).toLocaleTimeString()}` : 'Awaiting finalized RPC snapshot';
  $('supply-status').classList.toggle('stale', !!supply?.stale || !!status.supplyError);
  $('supply-error').textContent = status.supplyError || '';
  $('supply-error').hidden = !status.supplyError;
  for (const button of $('windows').querySelectorAll('button')) {
    button.classList.toggle('active', button.dataset.window === period);
    button.setAttribute('aria-pressed', String(button.dataset.window === period));
  }
}
function renderRows(result) {
  $('events').replaceChildren();
  for (const event of result.events) {
    const row = node('tr');
    const kind = node('td');
    kind.append(node('span', labels[event.type], `badge ${event.type}`));
    kind.append(link(`Record ${short(event.pda)} ↗`, `https://solscan.io/account/${event.pda}`, event.pda));
    kind.lastChild.className = 'sub';
    const amount = node('td', event.amount ?? '—', 'amount');
    if (event.amount !== null) amount.append(node('span', event.type === 'withdraw' ? 'XMR' : 'wXMR', 'unit'));
    if (event.reason) amount.append(node('span', event.reason, 'sub'));
    const wallet = node('td', undefined, 'wallet');
    wallet.append(link(event.owner, `https://solscan.io/account/${event.owner}`));
    const date = event.blockTime === null ? null : new Date(event.blockTime * 1000);
    const when = node('td', date ? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'Unknown time');
    if (date) { when.title = date.toISOString(); when.append(node('span', `${date.toLocaleTimeString()} · slot ${integer(event.slot)}`, 'sub')); }
    const tx = node('td', undefined, 'tx');
    tx.append(link(`${short(event.signature)} ↗`, event.txUrl, event.signature));
    row.append(kind, amount, wallet, when, tx);
    $('events').append(row);
  }
  if (!result.events.length) {
    const row = node('tr');
    const cell = node('td', status?.pending ? 'Loading bridge activity…' : 'No matching events indexed yet.', 'empty');
    cell.colSpan = 5;
    row.append(cell);
    $('events').append(row);
  }
  $('count').textContent = integer(result.total);
  $('range').textContent = result.total ? `${integer(offset + 1)}–${integer(offset + result.events.length)} of ${integer(result.total)} events` : '0 events';
  $('previous').disabled = offset === 0;
  $('next').disabled = offset + result.events.length >= result.total;
}

async function refresh() {
  clearTimeout(timer);
  const request = ++generation;
  try {
    const params = new URLSearchParams({ type, search, offset, limit: 50 });
    const responses = await Promise.all([fetch('/api/status'), fetch(`/api/events?${params}`)]);
    if (responses.some(response => !response.ok)) throw new Error('Explorer API unavailable');
    const [nextStatus, result] = await Promise.all(responses.map(response => response.json()));
    if (request !== generation) return;
    status = nextStatus;
    renderStats();
    renderRows(result);
    $('sync').textContent = status.lastSync ? `Synced ${new Date(status.lastSync).toLocaleTimeString()}` : 'Connecting to Helius…';
    const complete = status.historyExhausted && status.eventBackfillComplete && status.pending === 0 && !status.historyGap;
    $('coverage').textContent = `${complete ? 'RPC history indexed' : 'History indexing · totals cover indexed events'} · ${integer(status.transactionsScanned)} tx scanned${status.pending ? ` · ${integer(status.pending)} queued` : ''}${status.unresolved ? ` · ${integer(status.unresolved)} awaiting retry` : ''}`;
    $('error').textContent = status.error || '';
    $('error').hidden = !status.error;
  } catch (error) {
    if (request !== generation) return;
    $('error').textContent = error.message;
    $('error').hidden = false;
  } finally {
    if (request === generation) timer = setTimeout(refresh, 5000);
  }
}
$('windows').addEventListener('click', event => {
  if (event.target.dataset.window) { period = event.target.dataset.window; renderStats(); }
});
$('filters').addEventListener('click', event => {
  if (!Object.hasOwn(event.target.dataset, 'type')) return;
  type = event.target.dataset.type;
  offset = 0;
  for (const button of $('filters').querySelectorAll('button')) {
    button.classList.toggle('active', button.dataset.type === type);
    button.setAttribute('aria-pressed', String(button.dataset.type === type));
  }
  refresh();
});
let debounce;
$('search').addEventListener('input', () => {
  clearTimeout(debounce);
  debounce = setTimeout(() => { search = $('search').value.trim(); offset = 0; refresh(); }, 250);
});
$('previous').addEventListener('click', () => { offset = Math.max(0, offset - 50); refresh(); });
$('next').addEventListener('click', () => { offset += 50; refresh(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearTimeout(timer);
  else refresh();
});
refresh();
