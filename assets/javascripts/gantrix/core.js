/* 工程表 (Schedule) for Redmine (MIT License)
 * core: messages, dates and the working-day calendar, API, TSV, DOM helpers.
 * Classic script (no ES modules: Propshaft adds digests to file names); shares window.Gantrix. */
(() => {
  'use strict';
  const GX = (window.Gantrix ??= {});

  // ---------------------------------------------------------------- messages
  // From the Redmine locale files (config/locales/*.yml, key `gantrix_js`), rendered into the
  // page for the user's language; missing keys fall back to English on the server side.
  let MSG = {};
  let DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  let MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  GX.setMessages = (m = {}) => {
    MSG = m;
    if (m.abbr_day_names?.length === 7) DAYS = m.abbr_day_names;
    if (m.abbr_month_names?.length >= 12) MONTHS = m.abbr_month_names.filter(Boolean);
  };
  GX.T = (key, params) => {
    let s = MSG[key];
    if (s == null) {
      console.warn(`[gantrix] missing message: ${key}`);
      s = key;
    }
    return params ? String(s).replace(/%\{(\w+)\}/g, (m, k) => params[k] ?? m) : s;
  };

  // ---------------------------------------------------------------- dates (integer day numbers, UTC)
  const DAY = 86400000;
  // Date.UTC reads years 0-99 as 1900-1999; a typo such as 0003-01-20 must stay in year 3
  const utcDay = (y, m, d) => {
    const x = new Date(Date.UTC(2000, m, d));
    x.setUTCFullYear(y, m, d);
    return x;
  };
  GX.toDay = (s) => {
    if (s == null || s === '') return null;
    const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
    return Math.floor(utcDay(y, m - 1, d).getTime() / DAY);
  };
  GX.toStr = (d) => (d == null ? '' : new Date(d * DAY).toISOString().slice(0, 10));
  GX.dt = (d) => new Date(d * DAY);
  // day 0 (1970-01-01) is a Thursday
  GX.wday = (d) => (((d + 4) % 7) + 7) % 7;
  // "10/9(金)"; with refYear, another year is shown as "2027/3/23" (no weekday, so it fits a cell)
  GX.fmtDay = (d, refYear) => {
    if (d == null) return '';
    const x = GX.dt(d), y = x.getUTCFullYear(), md = `${x.getUTCMonth() + 1}/${x.getUTCDate()}`;
    return refYear && y !== refYear ? `${String(y).padStart(4, '0')}/${md}` : `${md}(${DAYS[x.getUTCDay()]})`;
  };
  // a period and other punctuation that differ by language ("10/1(木) 〜 10/8(木)" / "10/1(Thu) – 10/8(Thu)")
  GX.range = (s, e) => GX.T('range', { s, e });
  GX.fmtYM = (year, month) => GX.T('year_month', { year, month, month_name: MONTHS[month - 1] });
  GX.fmtMonth = (month) => GX.T('month', { month, month_name: MONTHS[month - 1] });

  // "2026/10/12", "2026-10-12", "10/12" (year taken from baseDay), full-width digits
  GX.parseDate = (text, baseDay) => {
    const t = String(text ?? '').trim()
      .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/[．。.\-年月]/g, '/').replace(/日$/, '').replace(/\(.*\)$/, '');
    let y, mo, d, m;
    if ((m = t.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/))) [y, mo, d] = [+m[1], +m[2], +m[3]];
    else if ((m = t.match(/^(\d{1,2})\/(\d{1,2})$/))) {
      y = baseDay != null ? GX.dt(baseDay).getUTCFullYear() : new Date().getFullYear();
      [mo, d] = [+m[1], +m[2]];
    } else return null;
    const x = utcDay(y, mo - 1, d);
    if (x.getUTCMonth() !== mo - 1 || x.getUTCDate() !== d) return null;
    return Math.floor(x.getTime() / DAY);
  };

  // Working days are counted by arithmetic (whole weeks, then a binary search over the sorted holidays),
  // the same way as Gantrix::Calendar on the server: a task until 9999-12-31 costs no more than a short one.
  GX.Calendar = class Calendar {
    constructor({ non_working_wdays = [], holidays = {} }) {
      this.off = new Set(non_working_wdays.map((w) => w % 7));
      this.holidays = {};
      for (const [k, name] of Object.entries(holidays)) this.holidays[GX.toDay(k)] = name;
      // holidays on working week days, sorted
      this.hd = Object.keys(this.holidays).map(Number).filter((d) => !this.off.has(GX.wday(d))).sort((a, b) => a - b);
      // prefix[r]: working week days among the r days from a Thursday (the week day of day 0)
      this.prefix = [0];
      for (let i = 0; i < 7; i++) this.prefix.push(this.prefix[i] + (this.off.has((i + 4) % 7) ? 0 : 1));
      this.perWeek = this.prefix[7];
    }
    isWorking(d) { return !this.off.has(GX.wday(d)) && !(d in this.holidays); }
    // (with every week day off there is no working day: the day is kept)
    nextWorking(d) { if (!this.perWeek) return d; while (!this.isWorking(d)) d++; return d; }
    // number of working days up to and including d, counted from day 0 (negative before it)
    through(d) {
      const j = d + 1, r = ((j % 7) + 7) % 7;
      let lo = 0, hi = this.hd.length; // holidays <= d
      while (lo < hi) { const m = (lo + hi) >> 1; if (this.hd[m] <= d) lo = m + 1; else hi = m; }
      return (j - r) / 7 * this.perWeek + this.prefix[r] - lo;
    }
    // the first day whose count reaches k, searching from +from+ in direction +dir+
    nth(k, from, dir) {
      let near = from, far = from + dir;
      while ((this.through(far) >= k) !== (dir > 0)) { near = far; far = from + (far - from) * 2; }
      let lo = Math.min(near, far), hi = Math.max(near, far);
      while (lo < hi) { const m = Math.floor((lo + hi) / 2); if (this.through(m) >= k) hi = m; else lo = m + 1; }
      return lo;
    }
    // n working days strictly after (n > 0) or before (n < 0) d
    step(d, n) {
      if (!n || !this.perWeek) return d;
      return n > 0 ? this.nth(this.through(d) + n, d, 1) : this.nth(this.through(d - 1) + n + 1, d, -1);
    }
    workingDays(s, e) {
      if (s == null || e == null || e < s) return 1;
      return Math.max(this.through(e) - this.through(s - 1), 1);
    }
    // signed number of working days to move from a to b
    between(a, b) {
      return b > a ? this.through(b) - this.through(a) : -(this.through(a - 1) - this.through(b - 1));
    }
    elapsed(s, e, base) { return base < s ? 0 : this.workingDays(s, Math.min(e, base)); }
  };

  // The period worth drawing for a set of days: dates far away from the others (9999-12-31 for "no end",
  // year 3 for a typo) would stretch a chart over thousands of years. The days are split where they are
  // more than two years apart; groups holding few of them (under 3 or under 10%) are left out unless they are
  // the largest or +keep+ (today) is near them,
  // and the result is at most five years (FOCUS_MAX_SPAN days), around +keep+ when it is inside. Returns [first, last].
  GX.FOCUS_GAP = 731;
  GX.FOCUS_MAX_SPAN = 365 * 5 + 1;
  GX.focusRange = (days, keep) => {
    const v = days.filter((d) => d != null && Number.isFinite(d)).sort((a, b) => a - b);
    if (!v.length) return keep == null ? null : [keep, keep];
    const groups = [];
    let g = { lo: v[0], hi: v[0], n: 1 };
    for (let i = 1; i < v.length; i++) {
      if (v[i] - g.hi > GX.FOCUS_GAP) { groups.push(g); g = { lo: v[i], hi: v[i], n: 0 }; }
      g.hi = v[i];
      g.n++;
    }
    groups.push(g);
    const near = (x) => keep != null && keep >= x.lo - GX.FOCUS_GAP && keep <= x.hi + GX.FOCUS_GAP;
    const biggest = groups.reduce((a, b) => (b.n > a.n ? b : a));
    const kept = groups.filter((x) => x === biggest || near(x) || (x.n >= 3 && x.n >= v.length * 0.1));
    let lo = Math.min(...kept.map((x) => x.lo)), hi = Math.max(...kept.map((x) => x.hi));
    // today joins the period when it is near the dates (a project finished years ago keeps its own period)
    if (keep != null && keep >= lo - GX.FOCUS_GAP && keep <= hi + GX.FOCUS_GAP) { lo = Math.min(lo, keep); hi = Math.max(hi, keep); }
    if (hi - lo > GX.FOCUS_MAX_SPAN) {
      const c = keep != null && keep >= lo && keep <= hi ? keep : hi;
      lo = Math.max(lo, Math.min(c - Math.floor(GX.FOCUS_MAX_SPAN / 2), hi - GX.FOCUS_MAX_SPAN));
      hi = lo + GX.FOCUS_MAX_SPAN;
    }
    return [lo, hi];
  };

  // ---------------------------------------------------------------- TSV (Excel clipboard)
  // Excel quotes cells that contain tabs, newlines or quotes.
  GX.parseTSV = (text) => {
    let src = String(text ?? '').replace(/\r\n?/g, '\n');
    if (src.endsWith('\n')) src = src.slice(0, -1);
    const rows = [];
    let row = [], cell = '', quoted = false;
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (quoted) {
        if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') quoted = false;
        else cell += c;
      } else if (c === '"' && cell === '') quoted = true;
      else if (c === '\t') { row.push(cell); cell = ''; }
      else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += c;
    }
    row.push(cell);
    rows.push(row);
    return rows;
  };
  GX.toTSV = (rows) => rows
    .map((r) => r.map((v) => {
      const s = String(v ?? '');
      return /[\t\n"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join('\t'))
    .join('\r\n');

  // ---------------------------------------------------------------- API
  // a long list sent as { columns: [...], rows: [[...], ...] } (much smaller than objects) -> objects
  GX.expandRows = (list) => {
    if (!list?.columns) return list ?? [];
    const cols = list.columns;
    return list.rows.map((r) => {
      const o = {};
      for (let i = 0; i < cols.length; i++) o[cols[i]] = r[i];
      return o;
    });
  };
  GX.api = async (base, method, path, body) => {
    const token = document.querySelector('meta[name="csrf-token"]')?.content ?? '';
    const res = await fetch(base + path, {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': token },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  };

  // ---------------------------------------------------------------- DOM helpers
  GX.el = (tag, attrs = {}, children = []) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'text') n.textContent = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k === 'class') n.className = v;
      else if (k === 'style') n.style.cssText = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children) if (c != null) n.append(c);
    return n;
  };
  const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  GX.esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ENTITIES[c]);

  // ---------------------------------------------------------------- icons
  // Tabler Icons (MIT) code points; gantrix-icons.woff2 holds only these glyphs: after changing the
  // list, rebuild it with tools/build_icons.py
  GX.ICONS = {
    plus: 0xeb0b, subtask: 0xec9f, 'indent-decrease': 0xeb91, 'indent-increase': 0xeb92,
    'arrow-up': 0xea25, 'arrow-down': 0xea16, trash: 0xeb41, 'arrow-back-up': 0xeb77, 'arrow-forward-up': 0xeb78,
    'calendar-share': 0xf82f, flag: 0xeaa6, 'columns-3': 0xf6d6, dots: 0xea95,
    target: 0xeb35, bolt: 0xea38, route: 0xeb17, 'chart-bar': 0xea59, 'eye-off': 0xecf0,
    'file-spreadsheet': 0xf03e, printer: 0xeb0e, 'external-link': 0xea99,
    copy: 0xea7a, cut: 0xea86, clipboard: 0xea6f, 'row-insert-top': 0xeed1, 'arrow-bar-to-down': 0xec88, eraser: 0xeb8b,
    'chevron-right': 0xea61, 'chevron-down': 0xea5f, 'chevrons-down': 0xea63, 'chevrons-up': 0xea66,
    filter: 0xeaa5, 'adjustments-horizontal': 0xec38,
  };
  const glyph = (name) => String.fromCodePoint(GX.ICONS[name]);
  // decorative: the button or link carries the text (or an aria-label)
  GX.icon = (name) => GX.el('i', { class: 'gx-i', 'aria-hidden': 'true', text: glyph(name) });
  GX.iconHtml = (name) => `<i class="gx-i" aria-hidden="true">${glyph(name)}</i>`;

  // shareable view state in the query string (?query_id=8): read once, replaced without reloading
  GX.urlParam = (name) => new URLSearchParams(location.search).get(name);
  GX.setUrlParams = (params) => {
    const url = new URL(location.href);
    for (const [k, v] of Object.entries(params)) {
      if (v == null || v === '') url.searchParams.delete(k); else url.searchParams.set(k, v);
    }
    history.replaceState(history.state, '', url);
  };
  GX.store = (key, val) => {
    try {
      if (val === undefined) return JSON.parse(localStorage.getItem(key));
      localStorage.setItem(key, JSON.stringify(val));
    } catch { /* storage may be unavailable */ }
    return null;
  };

  let toastTimer;
  GX.toast = (msg, isError = false) => {
    let el = document.querySelector('.gx-toast');
    if (!el) {
      el = GX.el('div', { class: 'gx-toast', role: 'status' });
      document.body.append(el);
    }
    el.textContent = msg;
    el.className = `gx-toast show${isError ? ' err' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'gx-toast'; }, isError ? 7000 : 2500);
  };
})();
