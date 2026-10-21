import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { validateSnapshot, PORT } from './model.js';

export function startBridge({ token, onSnapshot, port = PORT }) {
  const expected = Buffer.from(`Bearer ${token}`);
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    const reply = (status, body) => { res.writeHead(status); res.end(JSON.stringify(body)); };
    if (req.headers.host !== `127.0.0.1:${server.address().port}`) return reply(403, { error: 'Invalid host' });
    const auth = Buffer.from(req.headers.authorization || '');
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) return reply(401, { error: 'Pairing required' });
    if (req.method === 'GET' && req.url === '/health') return reply(200, { app: 'AgentUsageV2', version: 1 });
    if (req.method !== 'POST' || req.url !== '/usage') return reply(404, { error: 'Not found' });
    if (req.headers['content-type'] !== 'application/json') return reply(415, { error: 'JSON required' });
    let body = '';
    let tooLarge = false;
    req.setEncoding('utf8');
    req.on('data', chunk => {
      if (tooLarge) return;
      body += chunk;
      if (Buffer.byteLength(body) > 8192) { tooLarge = true; reply(413, { error: 'Payload too large' }); }
    });
    req.on('end', () => {
      if (tooLarge) return;
      let snapshot;
      try { snapshot = validateSnapshot(JSON.parse(body)); }
      catch { return reply(400, { error: 'Invalid usage data' }); }
      try { onSnapshot(snapshot); reply(200, { ok: true }); }
      catch { reply(500, { error: 'Could not save usage' }); }
    });
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
