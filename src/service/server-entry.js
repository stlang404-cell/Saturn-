// Game server process launched by the desktop shell. Runs the GameService (SQLite +
// local inference) under a standalone Node runtime bundled with SATURN, listening on
// 127.0.0.1 only, and requiring a per-launch secret token on every API call.
import { GameService } from './service.js';
import { startServer } from './web-server.js';

const svc = new GameService({ aiEnabled: process.env.SATURN_NO_AI !== '1', log: (...a) => console.error('[saturn]', ...a) });
const { server, port } = await startServer({ port: 0, svc, token: process.env.SATURN_TOKEN });
console.log(`SATURN_READY ${port}`);
svc.startAI().then(() => console.error('[saturn] AI:', svc.aiStatus.message));

const shutdown = async () => {
  try { svc.closeGame(); await svc.stopAI(); } catch { /* ignore */ }
  server.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
// exit when the shell goes away
process.stdin.on('end', shutdown);
process.stdin.resume();
