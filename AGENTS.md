# Database bootstrap maintenance

- The live cache (`data/`, or `DATA_DIR`) is local and ignored. Commit only `bootstrap/explorer.sqlite.xz` as the shared database snapshot. Never commit `.env`, RPC credentials, or SQLite WAL/SHM files.
- Startup seeds missing/empty databases from that archive; existing history must never be overwritten. Preserve the snapshot's metadata, history cursors, queue, events, and transaction fees so clones resume indexing instead of replaying history.
- After substantial local indexing or database/decoder changes, refresh the snapshot from an up-to-date cache. Check cached status with `npm start -- stats --json`; prefer no pending/unresolved transactions and completed history/event/fee backfills. Do not mark incomplete history as complete just to publish it.
- Run `scripts/update-bootstrap.sh` locally (Node 22.13+ and `xz` required). It honors `.env`/`DATA_DIR`, snapshots consistently with `VACUUM INTO`, and uses `xz -9e`. Do not copy an active SQLite file directly: committed data may still be in its WAL.
- Run `npm test` and check a fresh temporary `DATA_DIR` with `node src/cli.js stats --json` to verify startup restores the archive without RPC calls. Never delete the real cache to test restoration.
- Include the refreshed archive with relevant schema/decoder changes so it remains compatible with startup. Use `scripts/update-bootstrap.sh --push` when publishing a refresh is requested; this commits only the archive and pushes the current branch. Commit any application changes first.
