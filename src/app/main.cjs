// SATURN desktop shell (Electron main process).
//
// Electron provides only the window. The game itself — SQLite, the simulation and the
// local language model — runs in a separate process under a standalone Node runtime
// bundled with SATURN (resources/node). The prebuilt llama.cpp addon crashes inside
// Electron's embedded runtime (verified: "Illegal instruction"), and process isolation
// also means a model crash can never take the window or the save file down with it.
//
// Renderer ⇄ (IPC, whitelisted) ⇄ main ⇄ (HTTP on 127.0.0.1, per-launch secret token) ⇄ game server.
// The renderer itself makes no network requests at all; every request it attempts is cancelled.
const { app, BrowserWindow, ipcMain, dialog, session, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const SMOKE = process.env.SATURN_SMOKE === '1';
const TOKEN = crypto.randomBytes(24).toString('hex');
let server = null;
let port = null;
let win = null;
let serverLog = '';
let quitting = false;

function nodeBinary() {
  if (process.env.SATURN_NODE) return process.env.SATURN_NODE;
  const bundled = path.join(process.resourcesPath || '', 'node', process.platform === 'win32' ? 'node.exe' : 'node');
  return fs.existsSync(bundled) ? bundled : 'node'; // development: system Node
}

function startServer() {
  return new Promise((resolve, reject) => {
    const entry = path.join(__dirname, '..', 'service', 'server-entry.js');
    const dataDir = process.env.SATURN_HOME || app.getPath('userData');
    const env = { ...process.env, SATURN_HOME: dataDir, SATURN_TOKEN: TOKEN };
    delete env.ELECTRON_RUN_AS_NODE;
    if (process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'models'))) env.SATURN_MODELS = path.join(process.resourcesPath, 'models');
    server = spawn(nodeBinary(), [entry], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const timer = setTimeout(() => reject(new Error(`game server did not start:\n${serverLog}`)), 60000);
    server.stdout.on('data', (d) => {
      const m = String(d).match(/SATURN_READY (\d+)/);
      if (m && !port) { port = Number(m[1]); clearTimeout(timer); resolve(port); }
    });
    server.stderr.on('data', (d) => { serverLog = (serverLog + d).slice(-20000); process.stderr.write(d); });
    server.on('error', (e) => { clearTimeout(timer); reject(e); });
    server.on('exit', (code) => {
      clearTimeout(timer);
      if (!port) reject(new Error(`game server exited (${code}):\n${serverLog}`));
      else if (!quitting) dialog.showErrorBox('SATURN', `The game engine stopped unexpectedly (${code}). Your world is saved up to the last completed action. Please restart SATURN.`);
    });
  });
}

async function call(method, args) {
  const r = await fetch(`http://127.0.0.1:${port}/api`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-saturn-token': TOKEN }, body: JSON.stringify({ method, args }),
  });
  return r.json();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 980, minHeight: 640, backgroundColor: '#0d0f17', title: 'SATURN — The Living World',
    show: !SMOKE,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  // Offline guarantee for the UI: cancel every renderer request that is not a local file.
  session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
    const ok = details.url.startsWith('file://') || details.url.startsWith('devtools://') || details.url.startsWith('data:');
    if (!ok) console.warn('[saturn] blocked network request', details.url);
    cb({ cancel: !ok });
  });
  try {
    await startServer();
  } catch (e) {
    console.error(String(e.message));
    if (!SMOKE) dialog.showErrorBox('SATURN could not start', String(e.message).slice(0, 2000));
    else console.log('SATURN_SMOKE_RESULT ' + JSON.stringify({ ok: false, error: String(e.message).slice(0, 2000) }));
    app.exit(1);
    return;
  }
  ipcMain.handle('saturn:call', async (_e, method, args) => {
    try { return await call(method, args); } catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  ipcMain.handle('saturn:export', async () => {
    const r = await dialog.showSaveDialog(win, { title: 'Export world', defaultPath: 'saturn-world.saturn', filters: [{ name: 'SATURN world', extensions: ['saturn'] }] });
    if (r.canceled || !r.filePath) return null;
    const res = await call('exportSave', [r.filePath]);
    return res.ok ? r.filePath : null;
  });
  ipcMain.handle('saturn:import', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Import world', filters: [{ name: 'SATURN world', extensions: ['saturn'] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return null;
    const res = await call('importSave', [r.filePaths[0]]);
    return res.ok ? res.result : null;
  });
  createWindow();
  if (SMOKE) runSmoke();
});

async function runSmoke() {
  // Headless end-to-end check: UI loads, IPC + game server work, a turn resolves,
  // and (unless SATURN_NO_AI=1) the bundled model interprets a free-form sentence.
  const out = { ok: false };
  try {
    await new Promise((r) => win.webContents.once('did-finish-load', r));
    const wantAI = process.env.SATURN_NO_AI !== '1';
    if (wantAI) {
      const t0 = Date.now();
      let st = {};
      while (Date.now() - t0 < 600000) {
        st = (await call('aiStatus', [])).result || {};
        if (['ready', 'error', 'missing'].includes(st.state)) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      out.ai = { state: st.state, message: st.message };
      out.aiLoadMs = Date.now() - t0;
    }
    const js = `(async () => {
      const call = window.saturn.call;
      const ng = await call('newGame', { name: 'Smoke', background: 'clerk', seed: 1 });
      const r1 = await call('act', 'look');
      const r2 = await call('act', 'buy 1 bread');
      const r3 = ${wantAI} ? await call('act', 'I wander over to the innkeeper and quietly ask what she has heard about the grain shortage') : null;
      const integ = await call('integrity');
      return { title: document.title, player: ng.state.player.name, r1: r1.kind, r2: r2.outcomes[0].status, money: r2.state.player.money, r3: r3 && { kind: r3.kind, source: r3.source, narrationSource: r3.narrationSource, narration: r3.narration }, integ };
    })()`;
    out.result = await win.webContents.executeJavaScript(js);
    out.ok = out.result.r2 === 'done' && out.result.integ.sqlite === 'ok' && (!wantAI || (out.ai?.state === 'ready' && out.result.r3?.source === 'llm'));
  } catch (e) { out.error = String(e.message || e); out.serverLog = serverLog.slice(-2000); }
  console.log('SATURN_SMOKE_RESULT ' + JSON.stringify(out));
  await shutdown();
  app.exit(out.ok ? 0 : 1);
}

async function shutdown() {
  quitting = true;
  try { await call('closeGame', []); } catch { /* ignore */ }
  try { server?.stdin.end(); } catch { /* ignore */ }
  await new Promise((r) => { if (!server || server.exitCode != null) return r(); server.once('exit', r); setTimeout(r, 5000); });
  try { server?.kill(); } catch { /* ignore */ }
}

app.on('window-all-closed', async () => {
  await shutdown();
  app.quit();
});
