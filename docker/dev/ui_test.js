// Browser tests for the Excel-like schedule grid (Playwright).
//   NODE_PATH=<dir with playwright>/node_modules node docker/dev/ui_test.js 3006
// Covers: typing to overwrite, undo, IME composition, paste (update / errors / new rows), fill down, copy,
// icons and page loading (Lighthouse-relevant), opening issues, and the other screens.
const { chromium } = require('playwright');

// the published port (3006) or the container's address (172.19.0.3:3000, as docker/dev/test_all.sh passes it)
const target = process.argv[2] || '3006';
const base = `http://${target.includes(':') ? target : `127.0.0.1:${target}`}`;
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures++;
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.goto(`${base}/login`);
  await page.fill('#username', 'admin');
  await page.fill('#password', 'admin');
  await Promise.all([page.waitForNavigation(), page.click('#login-submit')]);
  // layout shifts while the page loads (Lighthouse CLS) and the icon font downloads
  await page.addInitScript(() => {
    window.__cls = 0;
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; })
      .observe({ type: 'layout-shift', buffered: true });
  });
  const fontRequests = [];
  page.on('request', (r) => { if (r.url().includes('.woff2')) fontRequests.push(r.url()); });
  await page.goto(`${base}/projects/demo/gantrix`);
  await page.waitForSelector('.gx-r');

  // 0. loading: the preloaded icon font is downloaded once, toolbar buttons have names, nothing shifts
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
  const preload = await page.$eval('link[rel=preload][as=font]', (l) => l.href).catch(() => null);
  check('icon font is preloaded and downloaded once', fontRequests.length === 1 && fontRequests[0] === preload, `${preload} / ${fontRequests.join(', ')}`);
  check('icon font is small', (await page.evaluate(async (u) => (await (await fetch(u)).arrayBuffer()).byteLength, preload)) < 8000);
  check('icons are drawn with the icon font', await page.evaluate(() => document.fonts.check("15px 'gantrix-icons'", String.fromCodePoint(0xeb0b))));
  const unnamed = await page.$$eval('.gx-toolbar button', (bs) => bs.filter((b) => !(b.getAttribute('aria-label') || b.textContent.replace(/[\ue000-\uf8ff]/g, '').trim())).length);
  check('every toolbar button has an accessible name', unnamed === 0, `${unnamed} without`);
  const cls = await page.evaluate(() => window.__cls);
  check('no layout shift while loading (CLS < 0.1)', cls < 0.1, cls.toFixed(3));
  if (process.env.TRACE) {
    page.on('console', (m) => console.log('  [page] ' + m.text()));
    await page.evaluate(() => {
      const g = document.getElementById('gantrix-schedule').app.grid;
      const o = g.startEdit.bind(g);
      g.startEdit = (...a) => { console.log('startEdit ' + JSON.stringify(a) + ' <- ' + new Error().stack.split('\n').slice(2, 6).map((x) => x.trim().split(' ')[1]).join(' < ')); return o(...a); };
      for (const m of ['commit', 'closeEdit']) { const f = g[m].bind(g); g[m] = (...x) => { console.log(m + ' ' + JSON.stringify(x) + ' edit=' + !!g.edit + ' val=' + g.proxy.value); return f(...x); }; }
    });
  }

  const data = () => page.evaluate(async () => {
    const j = await (await fetch('/projects/demo/gantrix/api/schedule', { headers: { Accept: 'application/json' } })).json();
    // tasks come as columns + rows (the page may not have loaded Gantrix)
    return { ...j, tasks: j.tasks.rows.map((r) => Object.fromEntries(j.tasks.columns.map((c, i) => [c, r[i]]))) };
  });
  const task = async (subject) => (await data()).tasks.find((t) => t.subject === subject);
  // the demo data is seeded around today, so dates are picked from it: n working days after a YYYY-MM-DD date
  const workday = (date, n) => page.evaluate(([d, k]) =>
    window.Gantrix.toStr(document.getElementById('gantrix-schedule').app.cal.step(window.Gantrix.toDay(d), k)), [date, n]);
  const slashed = (date) => date.replace(/-/g, '/');
  const settle = () => page.waitForFunction(() => !document.getElementById('gantrix-schedule').classList.contains('busy')).then(() => page.waitForTimeout(150));
  // select a cell by task subject and column key
  const selectCell = async (subject, key) => {
    await page.evaluate(([s, k]) => {
      const g = document.getElementById('gantrix-schedule').app.grid;
      const r = s === '__new__' ? g.rows.length : g.rows.findIndex((x) => x.task.subject === s);
      const c = g.cols.findIndex((x) => x.key === k);
      g.select(r, c);
    }, [subject, key]);
  };
  const pasteText = (text) => page.evaluate((t) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', t);
    document.querySelector('.gx-proxy').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);

  // 1. typing over a cell (no F2 needed), Enter commits and moves down
  const db = await task('DB設計');
  const dbDue = await workday(db.due_date, 2);
  await selectCell('DB設計', 'end');
  await page.keyboard.type(`${+dbDue.slice(5, 7)}/${+dbDue.slice(8)}`); // month/day, as typed by hand
  await page.keyboard.press('Enter');
  await settle();
  check('typing overwrites a date and saves', (await task('DB設計')).due_date === dbDue, `was ${db.due_date}, expected ${dbDue}`);
  const moved = await page.evaluate(() => { const g = document.getElementById('gantrix-schedule').app.grid; return g.rows[g.sel.r].task.subject; });
  check('Enter moves the selection down', moved === '基本設計レビュー', moved);

  // 2. undo
  await page.keyboard.press('Control+z');
  await settle();
  check('Ctrl+Z restores the previous value', (await task('DB設計')).due_date === db.due_date);

  // 3. IME: composition starts editing in place, Enter while composing does not commit
  const cdp = await page.context().newCDPSession(page);
  await selectCell('製造', 'assignee');
  await cdp.send('Input.imeSetComposition', { text: 'すずき', selectionStart: 3, selectionEnd: 3 });
  const editingDuringIme = await page.evaluate(() => !!document.getElementById('gantrix-schedule').app.grid.edit);
  check('IME composition starts editing in the cell', editingDuringIme);
  await page.evaluate(() => document.querySelector('.gx-proxy').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true })));
  check('Enter while composing keeps editing', await page.evaluate(() => !!document.getElementById('gantrix-schedule').app.grid.edit));
  await cdp.send('Input.insertText', { text: '鈴木' });
  await page.keyboard.press('Enter');
  await settle();
  check('confirmed IME text is saved (assignee 鈴木 花子)', (await task('製造')).assigned_to === '鈴木 花子', (await task('製造')).assigned_to);

  // 3b. composing on a read-only cell (parent assignee) is refused and leaves nothing behind
  await selectCell('基本設計', 'assignee');
  await cdp.send('Input.imeSetComposition', { text: 'あ', selectionStart: 1, selectionEnd: 1 });
  await cdp.send('Input.insertText', { text: 'あ' });
  const leaked = await page.evaluate(() => { const g = document.getElementById('gantrix-schedule').app.grid; return { edit: !!g.edit, val: g.proxy.value }; });
  check('read-only cell refuses IME input without leftovers', !leaked.edit && leaked.val === '', JSON.stringify(leaked));

  // 4. paste a 2x2 block (start/end of two rows) from Excel
  // a day later than now (not before its predecessor), 10 days, then 製造 right after it for 15 days
  const s1 = await workday((await task('詳細設計')).start_date, 1);
  const e1 = await workday(s1, 9), s2 = await workday(e1, 1), e2 = await workday(s2, 14);
  await selectCell('詳細設計', 'start');
  await pasteText(`${slashed(s1)}\t${slashed(e1)}\r\n${slashed(s2)}\t${slashed(e2)}\r\n`);
  await settle();
  const d1 = await task('詳細設計'), d2 = await task('製造');
  check('paste updates several rows and columns', d1.start_date === s1 && d1.due_date === e1 && d2.start_date >= s2,
    `${d1.start_date}..${d1.due_date}, ${d2.start_date}..${d2.due_date} (pasted ${s1}..${e1}, ${s2}..${e2})`);

  // 5. paste an invalid value: red cell with the reason, nothing sent
  await selectCell('単体テスト', 'start');
  await pasteText('あした');
  const err = await page.evaluate(() => document.querySelector('.gx-c.err')?.dataset.err ?? '');
  check('invalid pasted value is marked with a reason', err.length > 0, err);

  // 6. paste rows below the last task: leading spaces become subtasks
  await selectCell('__new__', 'subject');
  await pasteText('結合テスト準備\t\r\n  環境構築\t\r\n  テストデータ作成\t\r\n');
  await settle();
  const all = (await data()).tasks;
  const parent = all.find((t) => t.subject === '結合テスト準備');
  const kids = all.filter((t) => t.parent_id === parent?.id).map((t) => t.subject).sort();
  check('pasted rows are created with hierarchy', !!parent && kids.join(',') === 'テストデータ作成,環境構築', kids.join(','));

  // 7. fill down with Ctrl+D (progress of 詳細設計 copied to 製造)
  const fillValue = ((await task('製造')).done_ratio + 20) % 100 || 40;
  await selectCell('詳細設計', 'progress');
  await page.keyboard.type(String(fillValue));
  await page.keyboard.press('Enter');
  await settle();
  await page.evaluate(() => {
    const g = document.getElementById('gantrix-schedule').app.grid;
    const r = g.rows.findIndex((x) => x.task.subject === '詳細設計'), c = g.cols.findIndex((x) => x.key === 'progress');
    g.select(r, c);
    g.select(r + 1, c, true);
  });
  await page.keyboard.press('Control+d');
  await settle();
  check('Ctrl+D fills down', (await task('製造')).done_ratio === fillValue, `${(await task('製造')).done_ratio} (expected ${fillValue})`);

  // 8. copy produces TSV for Excel
  const tsv = await page.evaluate(() => {
    const g = document.getElementById('gantrix-schedule').app.grid;
    const r = g.rows.findIndex((x) => x.task.subject === '詳細設計'), c = g.cols.findIndex((x) => x.key === 'subject');
    g.select(r, c);
    g.select(r + 1, c + 2, true);
    const dt = new DataTransfer();
    const state = `edit=${!!g.edit} focus=${document.activeElement.className}`;
    document.querySelector('.gx-proxy').dispatchEvent(new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }));
    return dt.getData('text/plain') || state;
  });
  check('copy puts a TSV block on the clipboard', tsv.startsWith('詳細設計\t') && tsv.split('\t')[2] === `${slashed(s1)}\r\n製造`, JSON.stringify(tsv.slice(0, 60)));

  // 9. filter by a saved query: matching tasks plus their parents as context; the choice is kept on the server
  const appState = () => page.evaluate(() => {
    const a = document.getElementById('gantrix-schedule').app;
    return { queryId: a.queryId, rows: a.rows.map((r) => (r.task.context ? `(${r.task.subject})` : r.task.subject)) };
  });
  // queries are in the "tasks" menu of the toolbar
  const scopeItem = async (label) => { await page.click('.gx-scope'); await page.click(`.gx-menu .item:has-text("${label}")`); };
  await scopeItem('鈴木さんの担当');
  await settle();
  const filtered = await appState();
  const suzukiOnly = (await data()).tasks.filter((t) => t.assigned_to === '鈴木 花子').map((t) => t.subject);
  check('query filter keeps matching tasks and their parents',
    filtered.rows.filter((s) => !s.startsWith('(')).sort().join() === suzukiOnly.sort().join() && filtered.rows.some((s) => s.startsWith('(')),
    filtered.rows.join(','));
  await page.waitForTimeout(1200); // view settings are saved after a short delay
  await page.reload();
  await page.waitForSelector('.gx-r');
  await settle();
  check('view settings are restored from the server after reload', (await appState()).queryId === filtered.queryId);
  await page.click('.gx-scope');
  const groups = await page.evaluate(() => [...document.querySelectorAll('.gx-menu .head')].map((h) => `${h.textContent}:${h.nextElementSibling?.querySelector('.lab')?.textContent}`));
  check('bookmarked queries are listed first', groups[1]?.endsWith(':未完了のタスク'), groups.join(' | '));
  await page.mouse.click(5, 5);
  await scopeItem(await page.evaluate(() => window.Gantrix.T('view_needed')));
  await settle();
  await page.waitForTimeout(1200); // leave the view unfiltered for the next run

  // 10. print: every row on pages with repeated headers, screen restored afterwards
  const printed = await page.evaluate(() => {
    const a = document.getElementById('gantrix-schedule').app;
    a.print(...a.printSpan(), 'a4', false);
    const r = { sheets: document.querySelectorAll('.gx-sheet').length, heads: document.querySelectorAll('.gx-print .gx-head').length,
                rows: document.querySelectorAll('.gx-print .gx-r').length, expected: a.rows.length };
    window.dispatchEvent(new Event('afterprint'));
    r.cleaned = !document.querySelector('.gx-print') && !document.body.classList.contains('gx-printing');
    return r;
  });
  check('print lays out all rows on pages and cleans up', printed.rows === printed.expected && printed.heads === printed.sheets && printed.cleaned, JSON.stringify(printed));

  // ---- timeline editing ----
  const app = (fn, arg) => page.evaluate(([f, x]) => new Function('a', 'x', f)(document.getElementById('gantrix-schedule').app, x), [fn, arg]);
  const barBox = (subject) => page.evaluate((s) => {
    const a = document.getElementById('gantrix-schedule').app, t = a.data.tasks.find((x) => x.subject === s);
    const r = document.querySelector(`.gx-tl-bar[data-id="${t.id}"]`)?.getBoundingClientRect();
    return r && { x: r.x, y: r.y, w: r.width, h: r.height, id: t.id };
  }, subject);
  // scroll the chart so that the bar of +subject+ starts near the left edge of the timeline
  const showBar = async (subject, before = 2) => {
    await page.evaluate(([s, n]) => {
      const a = document.getElementById('gantrix-schedule').app, t = a.data.tasks.find((x) => x.subject === s);
      a.scrollToDay(t.s - n);
      a.grid.select(a.rowIndex[t.id], a.grid.sel.c);
    }, [subject, before]);
    await page.waitForTimeout(150);
  };

  // 11. dragging a bar moves the task (and the bar follows the mouse while dragging)
  const before11 = await task('DB設計');
  await showBar('DB設計');
  const bb = await barBox('DB設計');
  await page.mouse.move(bb.x + bb.w / 2, bb.y + bb.h / 2);
  await page.mouse.down();
  await page.mouse.move(bb.x + bb.w / 2 + 30, bb.y + bb.h / 2, { steps: 4 });
  await page.mouse.move(bb.x + bb.w / 2 + 66, bb.y + bb.h / 2, { steps: 4 });
  const dragging = await page.evaluate(() => !!document.querySelector('.gx-tl-bar.drag') && !!document.querySelector('.gx-tl-tip'));
  await page.mouse.up();
  await settle();
  const after11 = await task('DB設計');
  check('bar drag shows the dragged bar and a tooltip', dragging, dragging ? '' : JSON.stringify({ bb, at: await page.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return e && `${e.tagName}.${e.className.baseVal ?? e.className}`; }, [bb.x + bb.w / 2, bb.y + bb.h / 2]), vw: await page.evaluate(() => [innerWidth, innerHeight, scrollY]) }));
  check('bar drag moves the task by working days', after11.start_date > before11.start_date, `${before11.start_date} -> ${after11.start_date}`);
  await page.keyboard.press('Control+z');
  await settle();

  // 12. drag from the dot after a bar onto another bar: new dependency; click the arrow to delete it
  await showBar('要件定義書作成', 3);
  const from12 = await barBox('要件定義書作成'), to12 = await barBox('画面設計');
  await page.mouse.move(from12.x + from12.w / 2, from12.y + from12.h / 2);
  const dot = await page.evaluate((id) => { const r = document.querySelector(`.gx-tl-link[data-id="${id}"]`)?.getBoundingClientRect(); return r && { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, from12.id);
  const relCount = async () => (await data()).relations.filter((r) => r.to === to12.id).length;
  const n0 = await relCount();
  // 要件定義書作成 already precedes 画面設計 through 要件レビュー, so a direct link moves nothing
  const target = (await data()).relations.some((r) => r.from === from12.id && r.to === to12.id) ? null : to12;
  if (dot && target) {
    await page.mouse.move(dot.x, dot.y);
    await page.mouse.down();
    await page.mouse.move(Math.min(target.x + 14, 1270), target.y + target.h / 2, { steps: 6 }); // the bar may run past the window
    await page.mouse.up();
    await settle();
  }
  check('dragging the dot onto a bar adds a dependency', !!dot && !!target && (await relCount()) === n0 + 1, `${n0} -> ${await relCount()} ${JSON.stringify({ dot, from12, to12, target: !!target })}`);
  const rel = (await data()).relations.find((r) => r.from === from12.id && r.to === to12.id);
  const hitPoint = await page.evaluate((id) => {
    const p = document.querySelector(`.gx-tl-dep-hit[data-rel="${id}"]`);
    if (!p) return null;
    const pt = p.getPointAtLength(p.getTotalLength() / 2), box = p.ownerSVGElement.getBoundingClientRect();
    return { x: box.x + pt.x, y: box.y + pt.y };
  }, rel?.id);
  if (hitPoint) {
    await page.mouse.click(hitPoint.x, hitPoint.y);
    await page.click('.gx-menu .item');
    await settle();
  }
  check('clicking an arrow deletes the dependency', !!hitPoint && !(await data()).relations.some((r) => r.id === rel?.id), JSON.stringify(hitPoint));

  // 13. reschedule preview: list, ghost bars, nothing saved, cleared on cancel
  const before13 = await task('画面設計');
  await selectCell('画面設計', 'subject');
  await app('a.openReschedule()');
  await page.fill('.gx-dialog input[type=number]', '2');
  await page.waitForFunction(() => document.querySelectorAll('.gx-tl-ghost').length > 0, null, { timeout: 5000 }).catch(() => {});
  const pv = await page.evaluate(() => ({ text: document.querySelector('.gx-preview')?.innerText ?? '', ghosts: document.querySelectorAll('.gx-tl-ghost').length,
    okBg: getComputedStyle(document.querySelector('.gx-dialog .gx-btn.primary')).backgroundColor }));
  check('reschedule preview lists the moving tasks and draws ghost bars', /画面設計/.test(pv.text) && pv.ghosts > 0, `${pv.ghosts} ghosts / ${pv.text.replaceAll('\n', ' | ')}`);
  check('dialog buttons are visible (colors reach popups)', pv.okBg !== 'rgba(0, 0, 0, 0)' && pv.okBg !== 'transparent', pv.okBg);
  await page.keyboard.press('Escape');
  check('preview saves nothing and is cleared on cancel', (await task('画面設計')).start_date === before13.start_date && (await page.evaluate(() => document.querySelectorAll('.gx-tl-ghost').length)) === 0);

  // 14. critical path and workload pane
  const p14 = await app(`a.critical = true; a.loadPane = true; a.setupTimeline(); a.grid.render(); a.resize();
    return { crit: document.querySelectorAll('.gx-tl-bar.critical').length, load: document.querySelectorAll('.gx-load .gx-lr').length - 1,
             cells: document.querySelectorAll('.gx-load .gx-lc').length };`);
  check('critical path marks bars', p14.crit > 0, JSON.stringify(p14));
  check('workload pane shows assignees with their hours', p14.load >= 2 && p14.cells > 0, JSON.stringify(p14));
  await app('a.critical = false; a.loadPane = false; a.save(); a.setupTimeline(); a.grid.render();');
  await page.waitForTimeout(1200);

  // 14b. undo / redo: any number of steps, also adding, deleting (through the trash), moving and rescheduling;
  // the buttons are disabled when there is nothing to undo or redo
  const undoState = () => app('return { undo: a.undoBtn.disabled, redo: a.redoBtn.disabled, u: a.undoStack.length, r: a.redoStack.length };');
  await app('a.undoStack = []; a.redoStack = []; a.refreshUndo();');
  let us = await undoState();
  check('undo and redo are disabled with nothing to do', us.undo && us.redo, JSON.stringify(us));
  const newName = await page.evaluate(() => window.Gantrix.T('new_task'));
  await selectCell('結合テスト', 'subject');
  await page.click('.gx-split .gx-btn:first-child');
  await settle();
  await page.keyboard.press('Escape');
  const added = await task(newName);
  await selectCell(newName, 'subject');
  await page.keyboard.type('UNDO確認');
  await page.keyboard.press('Enter');
  await settle();
  await selectCell('UNDO確認', 'subject');
  await app('a.deleteSelected();');
  await settle();
  us = await undoState();
  check('adding, renaming and deleting are three steps', !(await task('UNDO確認')) && us.u === 3 && !us.undo && us.redo, JSON.stringify(us));
  await app('return a.undo();');
  check('undo of a delete brings the task back from the trash', (await task('UNDO確認'))?.id === added?.id);
  await app('return a.undo();');
  check('undo of a rename', (await task(newName))?.id === added?.id);
  await app('return a.undo();');
  us = await undoState();
  check('undo of adding moves the task to the trash; then only redo is possible',
    !(await data()).tasks.some((t) => t.id === added?.id) && us.undo && !us.redo && us.r === 3, JSON.stringify(us));
  for (let i = 0; i < 3; i++) await app('return a.redo();');
  us = await undoState();
  check('redo of the three steps', !(await data()).tasks.some((t) => t.id === added?.id) && !us.undo && us.redo, JSON.stringify(us));
  // a parent with its subtasks and their dependencies
  const snap0 = await data();
  const phase = snap0.tasks.find((t) => t.subject === '基本設計');
  const kidsBefore = snap0.tasks.filter((t) => t.parent_id === phase.id).map((t) => t.id).sort();
  const relsBefore = snap0.relations.length;
  await selectCell('基本設計', 'subject');
  await app('a.deleteSelected();');
  await settle();
  check('deleting a parent deletes its subtasks', !(await data()).tasks.some((t) => kidsBefore.includes(t.id)));
  await app('return a.undo();');
  const snap1 = await data();
  check('undo brings back the parent, its subtasks and their dependencies',
    snap1.tasks.filter((t) => t.parent_id === phase.id).map((t) => t.id).sort().join() === kidsBefore.join() && snap1.relations.length === relsBefore,
    `${snap1.relations.length} / ${relsBefore}`);
  // moving and rescheduling
  const wbsOf = async (s) => (await task(s)).wbs;
  const wbs0 = await wbsOf('製造');
  await selectCell('製造', 'subject');
  await app('a.moveSelected("up");');
  await settle();
  const wbs1 = await wbsOf('製造');
  await app('return a.undo();');
  check('undo of a move puts the task back', wbs1 !== wbs0 && (await wbsOf('製造')) === wbs0, `${wbs0} -> ${wbs1} -> ${await wbsOf('製造')}`);
  const rs0 = await task('単体テスト');
  await selectCell('単体テスト', 'subject');
  await app('a.openReschedule();');
  await page.fill('.gx-dialog input[type=number]', '2');
  await page.click('.gx-dialog .gx-btn.primary');
  await settle();
  const rs1 = await task('単体テスト');
  await app('return a.undo();');
  const rs2 = await task('単体テスト');
  check('undo of a reschedule puts the dates back', rs1.start_date !== rs0.start_date && rs2.start_date === rs0.start_date && rs2.due_date === rs0.due_date,
    `${rs0.start_date} -> ${rs1.start_date} -> ${rs2.start_date}`);
  await page.waitForTimeout(1200);

  // 15. report: EVM tiles, PV / EV / AC lines with hover, table view, phases
  await page.goto(`${base}/projects/demo/gantrix/report`);
  await page.waitForSelector('.gx-rp-tiles');
  const rp = await page.evaluate(() => ({
    tiles: document.querySelectorAll('.gx-rp-tile').length, lines: document.querySelectorAll('.gx-rp-svg .line').length,
    phases: document.querySelectorAll('.gx-rp-card .gx-rp-table tr').length - 1, spi: document.querySelectorAll('.gx-rp-tile')[1]?.querySelector('.gx-rp-tile-value')?.textContent,
  }));
  check('report shows the EVM tiles, three lines and the phases', rp.tiles === 5 && rp.lines === 3 && rp.phases >= 3 && /^\d\.\d\d$/.test(rp.spi), JSON.stringify(rp));
  const hit = await (await page.$('.gx-rp-svg .hit')).boundingBox();
  await page.mouse.move(hit.x + hit.width * 0.3, hit.y + hit.height / 2);
  check('chart hover shows a tooltip', await page.evaluate(() => !document.querySelector('.gx-rp-tip').hidden && /h/.test(document.querySelector('.gx-rp-tip').textContent)));
  await page.click('.gx-rp-card-head .gx-btn');
  check('table view lists the points', await page.evaluate(() => document.querySelectorAll('.gx-rp-chart .gx-rp-table tr').length > 3));

  // ---- phase 3 ----
  // 16. dashboard: topics and a quick fix (progress with a note) on the first card
  await page.goto(`${base}/projects/demo/gantrix/dashboard`);
  await page.waitForSelector('.gx-db-topics');
  const dash = await page.evaluate(() => {
    const d = document.getElementById('gantrix-dashboard').dashboard.data;
    return { tiles: document.querySelectorAll('.gx-db-topic').length, total: Object.values(d.topics).reduce((a, x) => a + x.length, 0),
             first: document.querySelector('.gx-db-card .gx-db-subj')?.textContent, id: +document.querySelector('.gx-db-card .gx-db-id')?.textContent.slice(1) };
  });
  check('dashboard shows five topics and task cards', dash.tiles === 5 && dash.total > 0 && !!dash.first, JSON.stringify(dash));
  await page.click('.gx-db-card .gx-db-btns .gx-btn.primary');
  await page.click('.gx-db-chip:has-text("90%")');
  await page.fill('.gx-db-memo input', 'ダッシュボードから入力');
  await page.click('.gx-db-edit .gx-btn.primary');
  await page.waitForFunction(() => !document.querySelector('.gx-db-edit'), null, { timeout: 8000 }).catch(() => {});
  const fixed = (await data()).tasks.find((t) => t.id === dash.id);
  check('progress entered on the dashboard is saved', fixed?.done_ratio === 90, `${dash.first}: ${fixed?.done_ratio}`);
  // the issue page (HTML, so the REST API need not be enabled)
  const journal = await page.evaluate(async (id) => (await (await fetch(`/issues/${id}`)).text()).includes('ダッシュボードから入力'), dash.id);
  check('the note is recorded in the issue history', journal);

  // 16b. a shared link opens the same topic (?topic=behind)
  await page.goto(`${base}/projects/demo/gantrix/dashboard?topic=behind`);
  await page.waitForSelector('.gx-db-topics');
  check('dashboard link with ?topic= opens that topic', await page.evaluate(() => !!document.querySelector('.gx-db-topic.behind.on')));

  // 17. kanban: drag a card to another status column, add a task
  await page.goto(`${base}/projects/demo/gantrix/kanban`);
  await page.waitForSelector('.gx-kb-board');
  const kb = await page.evaluate(() => {
    const k = document.getElementById('gantrix-kanban').kanban, d = k.data;
    const card = d.cards.find((c) => !d.statuses.find((s) => s.id === c.status_id).closed && c.allowed.length);
    const to = d.statuses.find((s) => card.allowed.includes(s.id) && !s.closed);
    return { cols: d.statuses.length, cards: d.cards.length, id: card?.id, to: to?.id, toName: to?.name };
  });
  check('kanban shows status columns with cards', kb.cols >= 3 && kb.cards > 0 && !!kb.id, JSON.stringify(kb));
  await page.dragAndDrop(`.gx-kb-card[data-id="${kb.id}"]`, `.gx-kb-col[data-status="${kb.to}"] header`); // the header is always on screen
  await page.waitForFunction(([id, to]) => document.getElementById('gantrix-kanban').kanban.data.cards.find((c) => c.id === id)?.status_id === to, [kb.id, kb.to], { timeout: 8000 }).catch(() => {});
  const moved17 = (await data()).tasks.find((t) => t.id === kb.id);
  check('dropping a card changes the status', moved17?.status_id === kb.to, `${moved17?.status} (expected ${kb.toName})`);
  const addBtn = await page.$('.gx-kb-add');
  if (addBtn) {
    await addBtn.click();
    await page.fill('.gx-kb-adder input', 'カンバンから追加');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('gantrix-kanban').kanban.data.cards.some((c) => c.subject === 'カンバンから追加'), null, { timeout: 8000 }).catch(() => {});
  }
  check('a task can be added from the kanban', !!(await task('カンバンから追加')));

  // 18. status colors: the admin setting reaches the schedule
  await page.goto(`${base}/admin/gantrix`);
  const statusId = moved17?.status_id;
  await page.fill(`#status_color_${statusId}`, '#123456').catch(() => {});
  await page.evaluate((id) => { const i = document.getElementById(`status_color_${id}`); i.value = '#123456'; }, statusId);
  await Promise.all([page.waitForNavigation(), page.click('form[action$="/admin/gantrix"] input[type=submit]')]);
  const colors = (await data()).status_colors;
  check('status color set in the admin settings is used', colors?.[statusId] === '#123456', JSON.stringify(colors));

  // ---- phase 4 ----
  // 19. portfolio: one row per project with a signal, weekly CSV, workload across projects
  await page.goto(`${base}/gantrix/portfolio`);
  await page.evaluate(() => { const x = document.getElementById('gantrix-portfolio').portfolio; x.tab = 'projects'; x.save(); });
  await page.reload();
  await page.waitForSelector('.gx-pf-table');
  const pf = await page.evaluate(() => ({ rows: [...document.querySelectorAll('.gx-pf-table tbody tr')].map((r) => r.querySelector('.gx-pf-name')?.textContent),
    signals: document.querySelectorAll('.gx-pf-table .gx-pf-sig i').length }));
  check('portfolio lists the projects with signals', pf.rows.some((n) => n?.includes('ナビシステム')) && pf.rows.some((n) => n?.includes('店舗アプリ')) && pf.signals === pf.rows.length, pf.rows.join(', '));
  // read the bytes: text() would drop the BOM that Excel needs
  const csv = await page.evaluate(async () => {
    const r = await fetch(document.querySelector('.gx-pf-csv').href), b = new Uint8Array(await r.arrayBuffer());
    return { type: r.headers.get('content-type'), bom: b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF, lines: new TextDecoder().decode(b).trim().split('\n').length };
  });
  check('weekly report CSV is /gantrix/portfolio.csv', await page.evaluate(() => new URL(document.querySelector('.gx-pf-csv').href).pathname.endsWith('/gantrix/portfolio.csv')));
  check('weekly report CSV (UTF-8 with BOM) has a row per project', csv.type.includes('text/csv') && csv.bom && csv.lines === pf.rows.length + 1, JSON.stringify(csv));
  await page.click('.gx-pf-tabs button:nth-child(2)');
  await page.waitForSelector('.gx-pf-load');
  check('the workload tab has its own URL', new URL(page.url()).pathname === '/gantrix/workload', page.url());
  await page.click('.gx-pf-load button.gx-pf-cell');
  const wl = await page.evaluate(() => ({ cells: document.querySelectorAll('.gx-pf-load button.gx-pf-cell').length, detail: document.querySelectorAll('.gx-pf-detail li').length }));
  check('workload across projects shows weekly cells and the tasks behind a cell', wl.cells > 0 && wl.detail > 0, JSON.stringify(wl));

  // 21. open an issue from the schedule: the link at the end of the task cell, the issue number column,
  //     double-clicking a bar; always in a new tab, the schedule keeps its selection
  await page.goto(`${base}/projects/demo/gantrix`);
  await page.waitForSelector('.gx-r');
  const opened = await task('画面設計');
  await selectCell('DB設計', 'subject');
  const selBefore = await page.evaluate(() => JSON.stringify(document.getElementById('gantrix-schedule').app.grid.sel));
  const subjectCell = page.locator('.gx-r .gx-c', { hasText: '画面設計' }).first();
  await subjectCell.hover();
  const link = subjectCell.locator('a.gx-open');
  check('the task cell links to its issue in a new tab', (await link.getAttribute('href')).endsWith(`/issues/${opened.id}`) && (await link.getAttribute('target')) === '_blank');
  const [tab1] = await Promise.all([page.context().waitForEvent('page'), link.click()]);
  await tab1.waitForLoadState();
  check('clicking the link opens the issue', new URL(tab1.url()).pathname === `/issues/${opened.id}`, tab1.url());
  await tab1.close();
  // the link of the selected cell works too (the editing proxy over the selected cell lets clicks through)
  await selectCell('画面設計', 'subject');
  await subjectCell.hover();
  const [tabSel] = await Promise.all([page.context().waitForEvent('page', { timeout: 5000 }), link.click()]);
  await tabSel.waitForLoadState();
  check('the link in the selected cell opens the issue', new URL(tabSel.url()).pathname === `/issues/${opened.id}`, tabSel.url());
  await tabSel.close();
  await selectCell('DB設計', 'subject');
  check('opening an issue keeps the selection', await page.evaluate(() => JSON.stringify(document.getElementById('gantrix-schedule').app.grid.sel)) === selBefore);

  const idTitle = await page.evaluate(() => window.Gantrix.T('col_id'));
  // columns are in the "view" menu of the toolbar
  const viewMenu = `.gx-toolbar .gx-dd:has-text("${await page.evaluate(() => window.Gantrix.T('view'))}")`;
  await page.click(viewMenu);
  await page.click(`.gx-menu .item:has-text("${idTitle}")`);
  await page.mouse.click(5, 5);
  const ids = await page.evaluate(() => ({ links: document.querySelectorAll('.gx-r a.gx-idlink').length, rows: document.querySelectorAll('.gx-r').length,
    after: document.getElementById('gantrix-schedule').app.grid.cols.findIndex((c) => c.key === 'id') - document.getElementById('gantrix-schedule').app.grid.cols.findIndex((c) => c.key === 'wbs') }));
  check('the issue number column links every row, next to the WBS number', ids.links > 0 && ids.after === 1, JSON.stringify(ids));
  await page.click(viewMenu);
  await page.click(`.gx-menu .item:has-text("${idTitle}")`);
  await page.mouse.click(5, 5);

  // earlier steps may have made the bar long: scroll to its start and double-click the visible left end
  await page.evaluate((id) => { const a = document.getElementById('gantrix-schedule').app; a.scrollToDay(a.byId[id].s - 3); }, opened.id);
  await page.waitForTimeout(200);
  const bar = page.locator(`.gx-tl-bar[data-id="${opened.id}"]`);
  const [tab2] = await Promise.all([page.context().waitForEvent('page'), bar.dblclick({ position: { x: 12, y: 6 } })]);
  await tab2.waitForLoadState();
  check('double-clicking a bar opens its issue', new URL(tab2.url()).pathname === `/issues/${opened.id}`, tab2.url());
  await tab2.close();
  const after = await task('画面設計');
  check('double-clicking a bar does not move it', after.start_date === opened.start_date && after.due_date === opened.due_date);

  // 20. the project overview shows no internal data (baselines used to appear there for admins)
  await page.goto(`${base}/projects/demo`);
  check('project overview does not show internal data', !(await page.content()).includes('"baselines"'));

  check('no JavaScript errors', errors.length === 0, errors.join(' / '));
  await browser.close();
  console.log(failures ? `${failures} FAILED` : 'ALL UI TESTS PASSED');
  process.exit(failures ? 1 : 0);
})();
