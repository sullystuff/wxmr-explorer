#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
if [[ $# -gt 1 || ( $# -eq 1 && $1 != --push ) ]]; then
  echo 'Usage: scripts/update-bootstrap.sh [--push]' >&2
  exit 1
fi
command -v xz >/dev/null
mkdir -p bootstrap
snapshot_dir=$(mktemp -d "$PWD/bootstrap/.snapshot-XXXXXX")
trap 'rm -rf -- "$snapshot_dir"' EXIT
# VACUUM INTO takes a consistent snapshot, including committed WAL contents.
node --disable-warning=ExperimentalWarning --env-file-if-exists=.env --input-type=module - "$snapshot_dir/explorer.sqlite" <<'JS'
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { config } from './src/config.js';
import { PROGRAM_ID, GENESIS_HASH } from './src/config.js';
const db = new DatabaseSync(join(config().dataDir, 'explorer.sqlite'), { readOnly: true });
try {
  if (JSON.parse(db.prepare("SELECT value FROM meta WHERE key='identity'").get()?.value ?? 'null') !== `${GENESIS_HASH}:${PROGRAM_ID}`) throw new Error('Wrong bridge database');
  if (!db.prepare('SELECT count(*) AS n FROM queue').get().n) throw new Error('Refusing to snapshot empty history');
  if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('Database integrity check failed');
  db.prepare('VACUUM INTO ?').run(process.argv[2]);
} finally { db.close(); }
JS
xz -9e -c -- "$snapshot_dir/explorer.sqlite" > "$snapshot_dir/explorer.sqlite.xz"
xz -t -- "$snapshot_dir/explorer.sqlite.xz"
mv -- "$snapshot_dir/explorer.sqlite.xz" bootstrap/explorer.sqlite.xz
ls -lh bootstrap/explorer.sqlite.xz
if [[ ${1:-} == --push ]]; then
  git add -- bootstrap/explorer.sqlite.xz
  git diff --cached --quiet -- bootstrap/explorer.sqlite.xz || git commit --only -m 'Refresh explorer bootstrap snapshot' -- bootstrap/explorer.sqlite.xz
  git push
fi
