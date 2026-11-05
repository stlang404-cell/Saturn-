// Local-only HTTP server exposing the GameService to the UI for development and
// browser-based testing. The desktop app uses Electron IPC instead. Binds to
// 127.0.0.1 only; no external requests are ever made.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GameService } from './service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.resolve(__dirname, '../ui');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' };

export const METHODS = ['creationOptions', 'listSaves', 'newGame', 'loadGame', 'deleteSave', 'state', 'act', 'confirmPlan', 'cancelPlan', 'cancel', 'snapshot', 'listSnapshots', 'restoreSnapshot', 'inspectTurn', 'inspectMemory', 'integrity', 'saveSettings', 'availableModels', 'aiStatus', 'closeGame', 'exportSave', 'importSave'];

export function dispatch(svc, method, args = []) {
  if (!METHODS.includes(method)) throw new Error(`Unknown method ${method}`);
  if (method === 'aiStatus') return { ...svc.aiStatus, models: svc.availableModels().map((m) => ({ file: m.file, profile: m.profile, size: m.size })) };
  return svc[method](...args);
}

export function startServer({ port = 7313, svc = new GameService(), token = null } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      if (token && req.headers['x-saturn-token'] !== token) { res.writeHead(403); res.end('forbidden'); return; }
      if (req.method === 'POST' && req.url === '/api') {
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 1e6) throw new Error('too large'); }
        const { method, args } = JSON.parse(body);
        const result = await dispatch(svc, method, args);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result }));
        return;
      }
      const rel = decodeURIComponent((req.url || '/').split('?')[0]);
      const file = path.normalize(path.join(UI_DIR, rel === '/' ? 'index.html' : rel));
      if (!file.startsWith(UI_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, svc, port: server.address().port })));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const noAi = process.argv.includes('--no-ai');
  const svc = new GameService({ aiEnabled: !noAi });
  const port = Number(process.env.PORT || 7313);
  startServer({ port, svc }).then(({ port: p }) => {
    console.log(`SATURN dev server on http://127.0.0.1:${p}`);
    if (!noAi) svc.startAI().then(() => console.log('AI:', svc.aiStatus.message));
  });
}
