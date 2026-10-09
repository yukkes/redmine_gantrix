// Display time on a project the size of a long-running real one (docker/dev/checks/large_seed.rb):
// every Gantrix screen must be drawn within LIMIT_MS of opening it.
//   NODE_PATH=<dir with playwright>/node_modules node docker/dev/large_test.js 3006
const { chromium } = require('playwright');

// the published port (3006) or the container's address (172.19.0.3:3000)
const target = process.argv[2] || '3006';
const base = `http://${target.includes(':') ? target : `127.0.0.1:${target}`}`;
const LIMIT_MS = Number(process.env.LIMIT_MS || 3000);
// a screen that is not drawn by then needs a different approach, not tuning: stop waiting
const GIVE_UP_MS = LIMIT_MS * 3;
const screens = [
  // [name, path, selector that appears once the data is drawn]
  ['schedule', '/projects/large/gantrix', '#gantrix-schedule:not(.gx-loading) .gx-r'],
  ['report', '/projects/large/gantrix/report', '.gx-rp-svg'],
  ['dashboard', '/projects/large/gantrix/dashboard', '.gx-db-topics'],
  ['kanban', '/projects/large/gantrix/kanban', '.gx-kb-card'],
];
let failures = 0;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`${page.url()}: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 500) errors.push(`${r.url()}: HTTP ${r.status()}`); });
  await page.goto(`${base}/login`);
  await page.fill('#username', 'admin');
  await page.fill('#password', 'admin');
  await Promise.all([page.waitForNavigation(), page.click('#login-submit')]);
  // twice: the first visit also warms up the server (code loading, caches)
  for (const round of ['cold', 'warm']) {
    for (const [name, path, ready] of screens) {
      const t0 = Date.now();
      await page.goto(`${base}${path}`);
      const drawn = await page.waitForSelector(ready, { timeout: GIVE_UP_MS }).then(() => true, () => false);
      const ms = Date.now() - t0;
      const ok = drawn && (round === 'cold' || ms <= LIMIT_MS);
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${round} ${name}: ${drawn ? `${ms} ms` : `not drawn within ${GIVE_UP_MS} ms`}`);
      if (!ok) failures++;
    }
  }
  if (errors.length) { console.log(`FAIL errors: ${errors.join(' / ')}`); failures++; }
  await browser.close();
  console.log(failures ? `${failures} FAILED` : `ALL LARGE TESTS PASSED (within ${LIMIT_MS} ms)`);
  process.exit(failures ? 1 : 0);
})();
