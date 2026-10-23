import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { ACTIVITY_TYPES } from './config.js';

export function web(store, config) {
  const files = new Map([
    ['/', ['text/html; charset=utf-8', readFileSync(new URL('../public/index.html', import.meta.url))]],
    ['/app.js', ['text/javascript; charset=utf-8', readFileSync(new URL('../public/app.js', import.meta.url))]],
    ['/time.js', ['text/javascript; charset=utf-8', readFileSync(new URL('./time.js', import.meta.url))]],
    ['/style.css', ['text/css; charset=utf-8', readFileSync(new URL('../public/style.css', import.meta.url))]],
  ]);
  const server = createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    const json = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET') { json(405, { error: 'GET only' }); return; }
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/events') {
      const type = url.searchParams.get('type') || '';
      const limit = Number(url.searchParams.get('limit') || 50);
      const offset = Number(url.searchParams.get('offset') || 0);
      if ((type && !ACTIVITY_TYPES.includes(type)) || !Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isInteger(offset) || offset < 0) {
        json(400, { error: 'Invalid event filter or page' }); return;
      }
      json(200, store.list({ type, limit, offset, search: (url.searchParams.get('search') || '').slice(0, 200) }));
    } else if (url.pathname === '/api/status') json(200, { ...store.status(), stats: store.stats() });
    else if (files.has(url.pathname)) {
      const [contentType, content] = files.get(url.pathname);
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
      res.end(content);
    } else json(404, { error: 'Not found' });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => resolve(server));
  });
}
