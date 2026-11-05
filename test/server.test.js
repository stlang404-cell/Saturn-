import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GameService } from '../src/service/service.js';
import { startServer } from '../src/service/web-server.js';

test('game server: loopback only, token required, whitelisted methods only', async () => {
  const svc = new GameService({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'saturn-srv-')), aiEnabled: false, log: () => {} });
  const { server, port } = await startServer({ port: 0, svc, token: 'secret' });
  assert.equal(server.address().address, '127.0.0.1');
  const post = (body, headers = {}) => fetch(`http://127.0.0.1:${port}/api`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await post({ method: 'listSaves', args: [] })).status, 403);
  const ok = await (await post({ method: 'newGame', args: [{ name: 'T', seed: 1 }] }, { 'x-saturn-token': 'secret' })).json();
  assert.equal(ok.ok, true);
  const bad = await (await post({ method: 'constructor', args: [] }, { 'x-saturn-token': 'secret' })).json();
  assert.equal(bad.ok, false);
  const turn = await (await post({ method: 'act', args: ['buy 1 bread'] }, { 'x-saturn-token': 'secret' })).json();
  assert.equal(turn.result.outcomes[0].status, 'done');
  svc.closeGame();
  server.close();
});
