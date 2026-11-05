// SATURN desktop shell (Electron main process).
// - Runs the GameService in the main process and exposes it to the UI over IPC.
// - The renderer is sandboxed with context isolation; it can only call a fixed
//   whitelist of service methods.
// - All network requests from the renderer are cancelled: SATURN is fully offline.
const { app, BrowserWindow, ipcMain, dialog, session, Menu } = require('electron');
const path = require('node:path');

let svc = null;
let dispatch = null;
let win = null;

const SMOKE = process.env.SATURN_SMOKE === '1';

async function boot() {
  const { GameService } = await import('../service/service.js');
  ({ dispatch } = await import('../service/web-server.js'));
  const dataDir = process.env.SATURN_HOME || path.join(app.getPath('userData'));
  svc = new GameService({ dataDir, aiEnabled: process.env.SATURN_NO_AI !== '1', log: (...a) => console.log('[saturn]', ...a) });
  svc.startAI().catch((e) => console.error('AI start failed', e));
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
  // Offline guarantee: cancel every request that is not a local file or devtools resource.
  session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
    const ok = details.url.startsWith('file://') || details.url.startsWith('devtools://') || details.url.startsWith('data:');
    if (!ok) console.warn('[saturn] blocked network request', details.url);
    cb({ cancel: !ok });
  });
  await boot();
  ipcMain.handle('saturn:call', async (_e, method, args) => {
    try { return { ok: true, result: await dispatch(svc, method, args) }; } catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  ipcMain.handle('saturn:export', async () => {
    const r = await dialog.showSaveDialog(win, { title: 'Export world', defaultPath: 'saturn-world.saturn', filters: [{ name: 'SATURN world', extensions: ['saturn'] }] });
    if (r.canceled || !r.filePath) return null;
    await svc.exportSave(r.filePath);
    return r.filePath;
  });
  ipcMain.handle('saturn:import', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Import world', filters: [{ name: 'SATURN world', extensions: ['saturn'] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return null;
    return svc.importSave(r.filePaths[0]);
  });
  createWindow();
  if (SMOKE) runSmoke();
});

async function runSmoke() {
  // Headless end-to-end check of the packaged/desktop path: UI loads, IPC works, a turn resolves.
  const out = { ok: false };
  try {
    await new Promise((r) => win.webContents.once('did-finish-load', r));
    const js = `(async () => {
      const call = window.saturn.call;
      const ng = await call('newGame', { name: 'Smoke', background: 'clerk', seed: 1 });
      const r1 = await call('act', 'look');
      const r2 = await call('act', 'buy 1 bread');
      const integ = await call('integrity');
      return { title: document.title, player: ng.state.player.name, r1: r1.kind, r2: r2.outcomes[0].status, money: r2.state.player.money, integ };
    })()`;
    out.result = await win.webContents.executeJavaScript(js);
    out.ok = out.result.r2 === 'done' && out.result.integ.sqlite === 'ok';
    out.ai = svc.aiStatus;
  } catch (e) { out.error = String(e.message || e); }
  console.log('SATURN_SMOKE_RESULT ' + JSON.stringify(out));
  svc.closeGame();
  app.exit(out.ok ? 0 : 1);
}

app.on('window-all-closed', async () => {
  try { svc?.closeGame(); await svc?.stopAI(); } catch { /* ignore */ }
  app.quit();
});
