// Performance check on a 1,000-task project (docker/dev/checks/perf_seed.rb).
//   NODE_PATH=<dir with playwright>/node_modules node docker/dev/perf_test.js 3006
const { chromium } = require('playwright');
// the published port (3006) or the container's address (172.19.0.3:3000)
const target = process.argv[2] || '3006';
const base = `http://${target.includes(':') ? target : `127.0.0.1:${target}`}`;
(async () => {
  const b = await chromium.launch();
  const page = await b.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${base}/login`);
  await page.fill('#username', 'admin'); await page.fill('#password', 'admin');
  await Promise.all([page.waitForNavigation(), page.click('#login-submit')]);
  // data API
  const api = await page.evaluate(async () => {
    const t0 = performance.now();
    const r = await fetch('/projects/perf/gantrix/api/schedule', { headers: { Accept: 'application/json' } });
    const j = await r.json();
    return { ms: Math.round(performance.now() - t0), tasks: j.tasks.rows.length, kb: Math.round(JSON.stringify(j).length / 1024) };
  });
  // page load until rows are drawn
  const t0 = Date.now();
  await page.goto(`${base}/projects/perf/gantrix`);
  await page.waitForSelector('.gx-r');
  const loadMs = Date.now() - t0;
  const rendered = await page.evaluate(() => document.querySelectorAll('.gx-r').length);
  // scroll through the whole table, measuring each window render
  const scroll = await page.evaluate(async () => {
    const g = document.getElementById('gantrix-schedule').app.grid, times = [];
    const max = g.scroll.scrollHeight - g.scroll.clientHeight;
    for (let y = 0; y <= max; y += 600) {
      g.scroll.scrollTop = y;
      const t = performance.now();
      g.dirty = true;
      g.renderWindow();
      times.push(performance.now() - t);
      await new Promise((r) => requestAnimationFrame(r));
    }
    times.sort((a, b) => a - b);
    return { steps: times.length, median: +times[times.length >> 1].toFixed(1), max: +times[times.length - 1].toFixed(1) };
  });
  // full re-render after an edit (rows + columns + timeline)
  const rerender = await page.evaluate(() => {
    const a = document.getElementById('gantrix-schedule').app, t = performance.now();
    a.buildRows(); a.grid.setRows(a.rows); a.grid.render();
    return +(performance.now() - t).toFixed(1);
  });
  const evmMs = await page.evaluate(async () => {
    const t0 = performance.now();
    const r = await fetch('/projects/perf/gantrix/api/evm?baseline_id=current', { headers: { Accept: 'application/json' } });
    await r.json();
    return r.ok ? Math.round(performance.now() - t0) : `HTTP ${r.status}`;
  });
  console.log(JSON.stringify({ api, loadMs, renderedRows: rendered, scroll, rerenderMs: rerender, evmMs }));
  await b.close();
})();
