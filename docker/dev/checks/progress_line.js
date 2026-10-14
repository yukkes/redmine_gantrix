// The actual progress-line renderer: node docker/dev/checks/progress_line.js
const assert = require('node:assert/strict');
global.window = {};
require('../../../assets/javascripts/gantrix/core.js');
require('../../../assets/javascripts/gantrix/timeline.js');
global.document = { readyState: 'complete', getElementById: () => null };
require('../../../assets/javascripts/gantrix/app.js');
const GX = window.Gantrix;
const cal = new GX.Calendar({ non_working_wdays: [6, 7] });
let base = GX.toDay(new Date().toISOString());
while (GX.wday(base) !== 5) base++;
const row = (progress, s = base, e = base + 3, extra = {}) => ({ progress, task: { s, e }, hasChildren: false, ...extra });
const make = (rows, calendar = cal) => new GX.Timeline({
  dayWidth: 22, firstDay: base - 30, lastDay: base + 30, baseDay: base, today: base,
  rowHeight: 28, rows: () => rows, relations: [], showInazuma: true, cal: calendar,
});
const bx = make([]).x(base + 1);
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
const points = (timeline, first = 0, last = timeline.ctx.rows().length) => {
  const svg = { innerHTML: '' };
  timeline.overlay(svg, first, last, true);
  const match = svg.innerHTML.match(/<polyline class="gx-tl-inazuma" points="([^"]+)"/);
  return match ? match[1].split(' ').map((p) => p.split(',').map(Number)) : [];
};

near(make([]).progressX(row(50)), bx);
near(make([]).progressX(row(40)), bx - 22 * .2);
near(make([]).progressX(row(60)), bx);
near(make([]).progressX(row(50, base, base + 3, { planned: 50 })), bx);
near(make([]).progressX(row(0)), make([]).x(base));
near(make([]).progressX(row(.01)), make([]).x(base + .0002));
near(make([]).progressX(row(0, base + 3, base + 7)), bx);
near(make([]).progressX(row(100, base + 3, base + 7)), bx);
const weekend = new GX.Timeline({ ...make([]).ctx, baseDay: base + 1 });
near(weekend.progressX(row(50)), weekend.x(base + 1));
assert.ok(weekend.progressX(row(40)) < weekend.x(base + 2));
const holidays = new GX.Calendar({ non_working_wdays: [6, 7], holidays: { [GX.toStr(base + 3)]: 'holiday' } });
near(make([], holidays).progressX(row(50, base, base + 4)), bx);

// Ten planned days, 50% done, twenty days past due: the notch is on day five, not five days before today.
const daily = new GX.Calendar({ non_working_wdays: [] });
const overdue = row(50, base - 29, base - 20);
const overdueLine = make([overdue], daily);
const fifthDay = base - 24;
near(overdueLine.progressX(overdue), overdueLine.x(fifthDay));
near(bx - overdueLine.progressX(overdue), 25 * overdueLine.dw);
const later = new GX.Timeline({ ...overdueLine.ctx, baseDay: base + 20 });
near(later.progressX(overdue), overdueLine.progressX(overdue));
near(later.x(base + 21) - later.progressX(overdue), 45 * later.dw);
const deadline = new GX.Timeline({ ...overdueLine.ctx, baseDay: overdue.task.e });
near(deadline.progressX(overdue), overdueLine.progressX(overdue));
near(overdueLine.progressX({ ...overdue, progress: 0 }), overdueLine.x(overdue.task.s));
near(overdueLine.progressX({ ...overdue, progress: .01 }), overdueLine.x(overdue.task.s + .001));
near(overdueLine.progressX({ ...overdue, progress: 100 }), overdueLine.x(overdue.task.e + 1));
for (const p of [0, .01, 10, 50, 90, 99, 100]) {
  near(overdueLine.progressX({ ...overdue, progress: p }), overdueLine.x(overdue.task.s + 10 * p / 100));
}
for (const zoom of ['day', 'week', 'month']) {
  const line = new GX.Timeline({ ...make([]).ctx, dayWidth: undefined, zoom });
  assert.ok(line.bgHTML().includes(`class="gx-tl-today" style="left:${line.x(base + 1)}px"`));
  near(line.progressX(row(100, base + 3, base + 7)), line.x(base + 1));
  near(line.progressX(row(0)), line.x(base));
}

const past = (p, extra = {}) => row(p, cal.step(base, -10), cal.step(base, -1), extra);
const pastHalf = past(50);
near(make([]).progressX(pastHalf), make([]).x(cal.step(pastHalf.task.s, 4) + 1));
const muchLater = new GX.Timeline({ ...make([]).ctx, baseDay: base + 14 });
near(muchLater.progressX(pastHalf), make([]).progressX(pastHalf));
const holidayPast = row(50, base, base + 4);
const holidayLate = new GX.Timeline({ ...make([], holidays).ctx, baseDay: base + 10 });
near(holidayLate.progressX(holidayPast), holidayLate.x(base + 1));
const mixed = make([past(100), past(50), past(100)]);
const mixedPoints = points(mixed);
const completedX = mixed.x(past(100).task.e + 1);
assert.deepEqual(mixedPoints.map(([x]) => x === completedX), [true, true, false, true, true]);
assert.ok(mixedPoints[2][0] < completedX);
const futureCompleted = make([row(100, base + 3, base + 7), past(50), past(100)]);
assert.deepEqual(points(futureCompleted).map(([x]) => x), [bx, bx, mixedPoints[2][0], completedX, completedX]);
assert.ok(points(make([past(100), past(100), past(100)])).every(([x]) => x === completedX));
for (const calendar of [cal, daily, holidays]) {
  for (const [s, e] of [[base - 20, base - 5], [base - 4, base + 8], [base + 3, base + 10], [base + 1, base + 2]]) {
    const line = make([], calendar);
    let previous = -Infinity;
    for (let p = 0; p <= 100; p += .5) {
      const x = line.progressX(row(p, s, e));
      assert.ok(x >= previous, `progress moved backwards at ${p}% (${s}, ${e})`);
      assert.ok(x <= bx, `progress went beyond today at ${p}%`);
      assert.ok(x >= Math.min(bx, line.x(s)), `progress went before the bar at ${p}%`);
      previous = x;
    }
    near(previous, Math.min(bx, line.x(e + 1)));
  }
}
const completedWeekend = new GX.Timeline({ ...make([]).ctx, baseDay: base + 10 });
near(completedWeekend.progressX(row(0, base + 1, base + 4)), completedWeekend.x(base + 1));
const holidayStart = new GX.Timeline({ ...make([], holidays).ctx, baseDay: base + 10 });
near(holidayStart.progressX(row(0, base + 3, base + 4)), holidayStart.x(base + 3));
near(completedWeekend.progressX(row(100, base, base + 2)), completedWeekend.x(base + 3));

const parent = past(50, { hasChildren: true, collapsed: true, planned: 100 });
assert.ok(make([]).progressX(parent) < bx);
assert.equal(make([]).progressX({ ...parent, collapsed: false }), null);
near(make([]).progressX({ ...parent, planned: 50 }), make([]).progressX(parent));
assert.equal(make([]).progressX(row(50, null, null)), null);
assert.deepEqual(points(make([row(50, null, null)])), []);
const parentPoints = points(make([parent]));
assert.equal(parentPoints.length, 3);
assert.ok(parentPoints.every(([x]) => x < bx));

const late = make([past(50), past(50), past(50), past(50)]);
const full = points(late);
const partial = points(late, 1, 3);
assert.deepEqual(partial, full.slice(1, -1));
assert.ok(partial.every(([x]) => x < bx));
assert.deepEqual(points(mixed, 1, 2), mixedPoints.slice(1, -1));

const app = Object.create(GX.App.prototype);
Object.assign(app, { cal, baseDay: base, data: { parent_dates_derived: true } });
const overdueApp = Object.create(GX.App.prototype);
Object.assign(overdueApp, { cal: daily, baseDay: base, data: { parent_dates_derived: true } });
const overdueGroup = { children: [
  { s: overdue.task.s, e: overdue.task.s + 4, done_ratio: 100, children: [] },
], hidden: [GX.toStr(overdue.task.s + 5), GX.toStr(overdue.task.e), null, null, false, 5, 0, 0, 0, 5] };
overdueApp.rollUp([overdueGroup]);
assert.equal(overdueGroup.progress, 50);
assert.equal(overdueGroup.planned, 100);
near(overdueLine.progressX({ task: overdueGroup, hasChildren: true, collapsed: true,
  progress: overdueGroup.progress, planned: overdueGroup.planned }), overdueLine.x(fifthDay));
const child = { s: cal.step(base, -3), e: cal.step(base, -2), done_ratio: 0, children: [] };
const hiddenStart = cal.step(base, 2), hiddenEnd = cal.step(base, 3);
const group = { children: [child], hidden: [GX.toStr(hiddenStart), GX.toStr(hiddenEnd), null, null, false, 2, 200, 0, 0, 0] };
app.rollUp([group]);
assert.equal(group.progress, 50);
assert.equal(group.planned, 50);
near(make([]).progressX({ task: group, hasChildren: true, collapsed: true, progress: group.progress, planned: group.planned }), make([]).x(base + .5));
const visibleGroup = { children: [child, { s: hiddenStart, e: hiddenEnd, done_ratio: 100, children: [] }] };
app.rollUp([visibleGroup]);
assert.equal(visibleGroup.planned, group.planned);
assert.equal(visibleGroup.progress, group.progress);
group.hidden[9] = 2;
app.rollUp([group]);
assert.equal(group.planned, 100);
near(make([]).progressX({ task: group, hasChildren: true, collapsed: true, progress: group.progress, planned: group.planned }), make([]).x(base + .5));
const fractionalGroup = { children: [
  { s: cal.step(base, -1), e: cal.step(base, -1), done_ratio: 100, children: [] },
  { s: cal.step(base, 140), e: cal.step(base, 141), done_ratio: 0, children: [] },
] };
app.rollUp([fractionalGroup]);
assert.equal(fractionalGroup.progress, 33);
near(make([]).progressX({ task: fractionalGroup, hasChildren: true, collapsed: true,
  progress: fractionalGroup.progress, planned: fractionalGroup.planned }), bx);
const pastFractionalGroup = { children: [
  { s: base - 9, e: base - 9, done_ratio: 100, children: [] },
  { s: base - 2, e: base - 1, done_ratio: 0, children: [] },
] };
overdueApp.rollUp([pastFractionalGroup]);
assert.equal(pastFractionalGroup.progress, 33);
near(make([], daily).progressX({ task: pastFractionalGroup, hasChildren: true, collapsed: true,
  progress: pastFractionalGroup.progress }), make([], daily).x(base - 6));
GX.setMessages({ planned_period: '%{s} - %{e}', progress_pct: '%{p}%', bar_open_tip: 'Open', link_drag_tip: 'Link' });
const handleLine = make([]);
Object.assign(handleLine.ctx, { canLink: true, statusOf: () => ({ name: 'Answered', kind: 'done' }) });
const handleRow = { ...past(100), days: 10 };
Object.assign(handleRow.task, { id: 1, subject: 'Task' });
const handleHTML = handleLine.rowHTML(handleRow);
assert.ok(handleHTML.includes(`class="gx-tl-link" data-id="1" style="left:${handleLine.x(handleRow.task.e + 1)}px"`));
assert.ok(handleHTML.includes('Answered 100%'));
assert.ok(!handleLine.rowHTML({ ...handleRow, hasChildren: true }).includes('gx-tl-link'));
assert.ok(!handleLine.rowHTML({ ...handleRow, task: { ...handleRow.task, e: base + 31 } }).includes('gx-tl-link'));
handleLine.ctx.canLink = false;
assert.ok(!handleLine.rowHTML(handleRow).includes('gx-tl-link'));
console.log('PROGRESS LINE CHECKS OK');
