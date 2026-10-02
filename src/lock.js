import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

// One history writer; additional terminal/web views can follow the same cache.
export function acquireLock(dataDir) {
  const path = join(dataDir, 'indexer.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, String(process.pid), { flag: 'wx', mode: 0o600 });
      return () => {
        if (existsSync(path) && readFileSync(path, 'utf8') === String(process.pid)) unlinkSync(path);
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(readFileSync(path, 'utf8'));
      if (!Number.isInteger(pid) || pid < 1) throw new Error('Invalid data/indexer.lock; check it before removing');
      try { process.kill(pid, 0); return null; }
      catch (probe) {
        if (probe.code !== 'ESRCH') return null;
        unlinkSync(path);
      }
    }
  }
  throw new Error('Could not acquire explorer cache lock');
}
