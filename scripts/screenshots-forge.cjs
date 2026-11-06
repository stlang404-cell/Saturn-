// Captures World Forge screenshots from a running dev server whose data dir contains a forged
// world (with its draft) in worlds/.   node scripts/screenshots-forge.cjs http://127.0.0.1:7315
const { chromium } = require('playwright');

(async () => {
  const base = process.argv[2] || 'http://127.0.0.1:7315';
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(base);
  await p.waitForSelector('text=Create World');
  await p.screenshot({ path: 'docs/screenshots/menu.png' });
  await p.click('[data-act="forge"]');
  await p.waitForSelector('#forgedesc');
  await p.click('[data-example="2"]');
  await p.screenshot({ path: 'docs/screenshots/forge.png' });
  await p.click('[data-act="title"]');
  await p.click('[data-titletab="library"]');
  await p.screenshot({ path: 'docs/screenshots/library.png' });
  await p.click('[data-editworld]');
  await p.waitForSelector('text=Laws of this world');
  await p.screenshot({ path: 'docs/screenshots/forge-preview.png', fullPage: true });
  await p.click('[data-act="title"]');
  await p.click('[data-titletab="library"]');
  await p.click('[data-newin^="library:"]');
  await p.waitForSelector('#cname');
  await p.fill('#cname', 'Ren');
  await p.screenshot({ path: 'docs/screenshots/forge-character.png' });
  await p.click('[data-act="begin"]');
  await p.waitForSelector('#input');
  for (const cmd of ['look', 'investigate']) {
    await p.fill('#input', cmd);
    await p.keyboard.press('Enter');
    await p.waitForFunction(() => !document.querySelector('.spinner'));
  }
  await p.screenshot({ path: 'docs/screenshots/forge-game.png' });
  await p.evaluate(() => document.querySelector('.side-col').scrollTo(0, 99999));
  await p.screenshot({ path: 'docs/screenshots/forge-world-tab.png' });
  console.log('page errors:', JSON.stringify(errors));
  await b.close();
})();
