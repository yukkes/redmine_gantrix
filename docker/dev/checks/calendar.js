// Gantrix.Calendar (core.js) counts working days arithmetically; check it against walking day by day,
// and Gantrix.focusRange on dates far from the others:  node docker/dev/checks/calendar.js
global.window = {};
require('../../../assets/javascripts/gantrix/core.js');
const GX = window.Gantrix;

// the plain definitions the calendar must agree with
const slow = (cal) => ({
  step(d, n) {
    const dir = n < 0 ? -1 : 1;
    for (let i = 0; i < Math.abs(n); i++) { d += dir; while (!cal.isWorking(d)) d += dir; }
    return d;
  },
  workingDays(s, e) {
    if (e < s) return 1;
    let c = 0;
    for (let d = s; d <= e; d++) if (cal.isWorking(d)) c++;
    return Math.max(c, 1);
  },
  between(a, b) {
    let n = 0;
    if (b > a) { for (let d = a + 1; d <= b; d++) if (cal.isWorking(d)) n++; } else { for (let d = b; d < a; d++) if (cal.isWorking(d)) n--; }
    return n;
  },
});

let seed = 7;
const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
const holidays = {};
for (let i = 0; i < 400; i++) holidays[GX.toStr(GX.toDay('2018-01-01') + rand(4500))] = 'h';
const calendars = {
  'Saturday and Sunday, holidays': new GX.Calendar({ non_working_wdays: [6, 7], holidays }),
  'Sunday only, holidays': new GX.Calendar({ non_working_wdays: [7], holidays }),
  'no week days off, holidays': new GX.Calendar({ non_working_wdays: [], holidays }),
  'Friday and Saturday, none': new GX.Calendar({ non_working_wdays: [5, 6] }),
};
let failures = 0, checks = 0;
for (const [name, cal] of Object.entries(calendars)) {
  const ref = slow(cal), bad = [];
  for (let i = 0; i < 3000; i++) {
    const a = GX.toDay('2017-06-01') + rand(5200), b = a + rand(420) - 10, n = rand(121) - 60;
    checks += 3;
    if (cal.workingDays(a, b) !== ref.workingDays(a, b)) bad.push(`workingDays(${GX.toStr(a)}, ${GX.toStr(b)})`);
    if (cal.step(a, n) !== ref.step(a, n)) bad.push(`step(${GX.toStr(a)}, ${n})`);
    if (cal.between(a, b) !== ref.between(a, b)) bad.push(`between(${GX.toStr(a)}, ${GX.toStr(b)})`);
  }
  failures += bad.length;
  console.log(`${bad.length ? 'FAIL' : 'ok  '} ${name}${bad.length ? `: ${bad.slice(0, 5).join(', ')}` : ''}`);
}
// years 3 to 9999 at once, and no working day at all
const cal = calendars['Saturday and Sunday, holidays'];
const t0 = Date.now(), y3 = GX.toDay('0003-01-20'), y9999 = GX.toDay('9999-12-31');
const far = cal.workingDays(y3, y9999), back = cal.step(y9999, -(far - 1)), ms = Date.now() - t0;
const none = new GX.Calendar({ non_working_wdays: [1, 2, 3, 4, 5, 6, 7] });
const ok = back === cal.nextWorking(y3) && ms < 50 && none.step(100, 5) === 100 && none.nextWorking(100) === 100;
checks++;
if (!ok) failures++;
console.log(`${ok ? 'ok  ' : 'FAIL'} years 3 to 9999: ${far} working days, back to ${GX.toStr(back)} in ${ms} ms`);

// focusRange: the dates worth drawing
const today = GX.toDay('2026-10-09');
const range = (list) => (GX.focusRange(list.map(GX.toDay), today) ?? []).map(GX.toStr).join(' - ');
const cases = [
  [['2021-12-01', '2026-12-01', '9999-12-31', '0003-01-20'], '2021-12-01 - 2026-12-01'],
  [['2026-01-05', '2026-03-31', '9999-12-31'], '2026-01-05 - 2026-10-09'],
  [['2015-04-01', '2016-03-31'], '2015-04-01 - 2016-03-31'],
  // a project of 15 years: the five years around today
  [Array.from({ length: 180 }, (_, i) => `${2016 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-01`), '2024-04-09 - 2029-04-09'],
  [['1990-01-01', '2026-10-01', '2026-10-02'], '2026-10-01 - 2026-10-09'],
  [[], '2026-10-09 - 2026-10-09'],
];
for (const [list, want] of cases) {
  checks++;
  const got = range(list);
  if (got !== want) { failures++; console.log(`FAIL focusRange(${list.join(', ')}) = ${got}, want ${want}`); }
}
console.log(failures ? `CALENDAR JS CHECKS FAILED: ${failures} of ${checks}` : `CALENDAR JS CHECKS OK (${checks})`);
process.exit(failures ? 1 : 0);
