# wXMR explorer

A small read-only explorer for finalized Solana bridge activity and the current wXMR supply:

- **Deposit address created** — `DepositAccountCreatedEvent` (creation of the deposit account).
- **Mint deposit** — `DepositMintedEvent`, with the minted amount.
- **Withdraw request** — `WithdrawRequestedEvent`, with the net requested amount.

The original `DepositCompletedEvent` is also included as a mint deposit. Withdrawal reversals and cancellations are indexed for accounting but do not appear in activity. Address assignments, claims, withdrawal completions, fee updates, and operational audit traffic do not appear in the feed. A withdrawal request is not proof of a completed XMR payment.

## Terminal — default

Requires **Node.js 22.13+**. No build, web server, wallet connection, or port forwarding is needed.

```sh
npm ci
cp .env.example .env
# Set SOLANA_RPC_URL in .env to your Helius mainnet endpoint.
npm start
```

The terminal dashboard refreshes automatically and shows the **current on-chain wXMR supply** separately from **8h, 24h, 7d, and all-indexed** minted volume, net withdrawals, event counts, and indexed net flow. Times in the activity table are UTC. Press Enter on a selected event for full addresses, amounts, and transaction links.

| Key | Action |
| --- | --- |
| `0`, `1`, `2`, `3` | All, deposit creation, mint, withdrawal |
| `/` | Search wallet, deposit/withdrawal record, XMR destination, or transaction |
| `n`, `p` | Older/newer page |
| `↑`, `↓`, Enter | Select an event and show its full details |
| Escape | Close details or clear search |
| `q`, Ctrl-C | Quit |

```sh
npm start -- --type mint
npm start -- --search SOLANA_WALLET
npm start -- --json                  # Live JSONL; also works without a TTY.
npm run events -- --limit 50         # Cached activity; makes no RPC calls.
npm run events -- --type withdraw --json
npm start -- stats --json            # Cached volumes and indexing status.
npm run sync -- --passes 8           # Bounded sync, about 25 transactions per pass.
```

When stdout is redirected, the default dashboard becomes a plain event stream. `--json` emits one event per line. Cached JSON events include full signatures, addresses, `amountAtomic`, and a decimal `amount` string.

## Optional web UI

```sh
npm run web
```

Open **http://127.0.0.1:3100** for the same activity, filters, search, pagination, and volume periods. The web view refreshes every five seconds. No frontend build is necessary. `HOST` and `PORT` can be changed in `.env`.

The terminal and web UI can run together: the first process indexes history, and additional views follow its local cache. If the writer exits, restart a view to resume indexing. Only the optional web command opens a listening port.

## Volume and coverage

All amounts use **12 decimal places** (1 XMR = 10¹² atomic units). Atomic amounts are strings; sums use BigInt rather than floating-point arithmetic.

- **On-chain supply** is read directly from the mainnet wXMR mint, `WXMRyRZhsa19ety5erZhHg4N3xj3EVN92u94422teJp`, using `getTokenSupply` at finalized commitment. It is independent of the volume window and indexed history. The snapshot includes its finalized slot and check time; a failed refresh or a snapshot older than 60 seconds is marked stale. Cached `stats` commands do not refresh it.
- Deposit volume includes the wXMR minted by both `DepositMintedEvent` and the original `DepositCompletedEvent`.
- **Net withdrawal volume** is XMR requested/burned minus wXMR re-minted by reversals/cancellations, excluding bridge fees. Both movements use their own transaction block times, so net withdrawals can be negative in a window containing a reversal of an older request. Request counts and activity still reflect the original requests, rather than completed payouts.
- Refunds adjust net withdrawal volume internally; there is no separate refund view or summary. The retained fee is not refunded.
- **Indexed net flow = minted deposits − net withdrawals**, expressed in XMR units. It is not a reserve balance or a substitute for on-chain supply: token burns outside the bridge and missing provider history can make them differ.
- Time windows use transaction block times. Events without a known block time count only toward all-indexed totals.

The explorer starts with the newest transactions and gradually backfills older history. Until backfill finishes, totals cover **indexed events only**. The views show scanned transactions, queued work, and unavailable/undecodable transactions awaiting retry. “RPC history indexed” means all history returned by this endpoint was processed; it cannot establish that the provider retained the bridge's entire lifetime. `sync` is a bounded pass, not a full-history completion guarantee.

Existing caches upgrade automatically when an indexer starts. The upgrade reprocesses the early history before the first indexed mint and checks the indexed withdrawal PDAs for refund transactions. It retains all existing events and normal history cursors, resumes after interruption, and skips the bulk of unrelated audit traffic. Coverage remains incomplete until the upgrade and its queued work finish. Additional views follow the writer's cached supply and upgrade progress.

The indexer uses finalized signature history and finalized transactions, verifies the mainnet genesis hash and executable bridge program, and decodes events only from successful invocations of `EzBkC8P5wxab9kwrtV5hRdynHAfB5w3UPcPXNgMseVA8`, including CPI. Event-shaped logs from other programs and failed invocations are discarded. Unavailable or truncated transactions remain queued. SQLite transactions atomically persist events and mark their signatures processed; persisted cursors and queues survive restart.

The decoder also supports the bridge's older withdrawal/refund layouts from before `fee` and `exact_out` were added. Fields absent from historical events, including the cumulative total on original deposit completions, are `null`, not invented values.

## Configuration and credentials

```dotenv
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_API_KEY
POLL_INTERVAL_MS=15000
RPC_INTERVAL_MS=300
DATA_DIR=./data
HOST=127.0.0.1
PORT=3100
```

`.env`, environment variants, local SQLite state, logs, and dependencies are ignored by Git. Only `.env.example` is tracked. The Helius URL is used by Node only; it is never returned by the API or included in browser assets. Provider error bodies are not logged. No signing, transaction submission, Monero wallet access, or bridge backend access is used.

History lives in `data/explorer.sqlite`; it is independent of the bridge's databases. HTTP reads are paced and transaction requests are batched in groups of up to 25. The live signature poll defaults to 15 seconds; historical backfill continues while the process runs and uses Helius credits.

```sh
npm test
```

References: [Solana signature history](https://solana.com/docs/rpc/http/getsignaturesforaddress), [transaction retrieval](https://solana.com/docs/rpc/http/gettransaction), [Node SQLite](https://nodejs.org/api/sqlite.html).
