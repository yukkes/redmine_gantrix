// Screenshots for the README in one language (Playwright), from demo data seeded in that language.
//   docker/dev/screenshots.sh takes both sets (it reseeds Redmine for each language).
//   NODE_PATH=<dir with playwright>/node_modules node docker/dev/screenshots.js 3006 docs/screenshots en
const { chromium } = require('playwright');
const fs = require('fs');

const port = process.argv[2] || '3006';
const out = process.argv[3] || 'docs/screenshots';
const lang = process.argv[4] || 'ja';
const base = `http://127.0.0.1:${port}`;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/login`);
  await page.fill('#username', 'admin');
  await page.fill('#password', 'admin');
  await Promise.all([page.waitForNavigation(), page.click('#login-submit')]);
  const idle = () => page.waitForFunction(() => !document.querySelector('.busy')).then(() => page.waitForTimeout(400));

  {
    fs.mkdirSync(`${out}/${lang}`, { recursive: true });
    const shot = (name) => page.screenshot({ path: `${out}/${lang}/${name}.png` });

    // schedule with the critical path and the workload pane
    await page.goto(`${base}/projects/demo/gantrix`);
    await page.waitForSelector('.gx-r');
    await page.evaluate(() => {
      const a = document.getElementById('gantrix-schedule').app;
      a.critical = true;
      a.loadPane = true;
      a.extraCols = ['preds', 'slack'];
      a.setupTimeline(); a.grid.setColumns(a.columns()); a.grid.render(); a.resize();
    });
    await idle();
    await shot('schedule');

    // reschedule preview (ghost bars), cancelled afterwards
    await page.evaluate(() => {
      const g = document.getElementById('gantrix-schedule').app.grid;
      const r = g.rows.findIndex((x) => x.wbs === '1.3'); // the requirements review
      g.select(r, 2);
      document.getElementById('gantrix-schedule').app.openReschedule();
    });
    await page.fill('.gx-dialog input[type=number]', '3');
    await page.waitForSelector('.gx-tl-ghost');
    await page.waitForTimeout(300);
    await shot('reschedule-preview');
    await page.keyboard.press('Escape');
    await page.evaluate(() => { const a = document.getElementById('gantrix-schedule').app; a.critical = false; a.loadPane = false; a.extraCols = ['preds']; a.save(); });
    await page.waitForTimeout(1000);

    await page.goto(`${base}/projects/demo/gantrix/dashboard?topic=behind`);
    await page.waitForSelector('.gx-db-topics');
    await page.click('.gx-db-card .gx-db-btns .gx-btn.primary').catch(() => {});
    await idle();
    await shot('dashboard');

    await page.goto(`${base}/projects/demo/gantrix/kanban`);
    await page.waitForSelector('.gx-kb-board');
    await idle();
    await shot('kanban');

    await page.goto(`${base}/projects/demo/gantrix/report`);
    await page.waitForSelector('.gx-rp-tiles');
    await idle();
    await shot('report');

    await page.goto(`${base}/gantrix/portfolio`);
    await page.waitForSelector('.gx-pf-table');
    await idle();
    // a short page: a lower window that just fits it, instead of an empty rest of the window
    await page.setViewportSize({ width: 1280, height: 200 });
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.setViewportSize({ width: 1280, height: Math.min(800, height) });
    await idle();
    await shot('portfolio');
    await page.setViewportSize({ width: 1280, height: 800 });
  }
  await browser.close();
  console.log(errors.length ? `errors: ${errors.join(' / ')}` : 'screenshots saved');
})();
