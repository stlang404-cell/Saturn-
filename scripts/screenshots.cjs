// Captures documentation screenshots from a running dev server (npm run web -- --no-ai).
//   node scripts/screenshots.cjs [baseUrl=http://127.0.0.1:7313]
const { chromium } = require('playwright');

(async () => {
  const base = process.argv[2] || 'http://127.0.0.1:7313';
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(base);
  await p.waitForSelector('text=New journey');
  await p.screenshot({ path: 'docs/screenshots/title.png' });
  await p.click('text=New journey');
  await p.fill('#cname', 'Wren');
  await p.click('[data-bg="herbalist"]');
  await p.screenshot({ path: 'docs/screenshots/create.png' });
  await p.click('[data-act="begin"]');
  await p.waitForSelector('#input');
  const cmds = ['ask Mirela what she has heard about the bread prices', 'go to the temple', 'talk to Brother Aldous', 'accept the task', 'go to the fields', 'go to the whisperwood', 'gather silverleaf'];
  for (const cmd of cmds) {
    await p.fill('#input', cmd);
    await p.keyboard.press('Enter');
    await p.waitForFunction(() => !document.querySelector('.spinner'));
    await p.waitForTimeout(100);
  }
  await p.screenshot({ path: 'docs/screenshots/game.png' });
  await p.click('[data-tab="map"]');
  await p.waitForTimeout(100);
  await p.screenshot({ path: 'docs/screenshots/map.png' });
  await p.click('[data-tab="relationships"]');
  await p.waitForTimeout(100);
  await p.click('[data-mem]');
  await p.waitForSelector('.modal');
  await p.screenshot({ path: 'docs/screenshots/memory-inspector.png' });
  await p.keyboard.press('Escape');
  const all = await p.$$('button.chip[data-inspect]');
  if (all.length) {
    await all[all.length - 1].click();
    await p.waitForSelector('.modal');
    await p.screenshot({ path: 'docs/screenshots/roll-inspector.png' });
  }
  console.log('page errors:', JSON.stringify(errors));
  await b.close();
})();
