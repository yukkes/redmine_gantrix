/* 工程表 (Schedule) for Redmine (MIT License)
 * report: earned value (EVM) of the project: summary tiles, cumulative PV / EV / AC chart
 * (with a table view) and the numbers per phase. */
(() => {
  'use strict';
  const GX = window.Gantrix;
  const { T, esc, el } = GX;
  // PV, EV, AC: first three slots of the categorical palette (validated; AC's low contrast is
  // relieved by direct labels and the table view). Line style is a second encoding.
  const SERIES = [
    { key: 'pv', label: 'series_pv', color: '#2a78d6', dash: '6 4' },
    { key: 'ev', label: 'series_ev', color: '#eb6834', dash: '' },
    { key: 'ac', label: 'series_ac', color: '#1baf7a', dash: '1.5 4' },
  ];
  const STATUS_ICON = { good: '✓', warn: '!', bad: '✕' };
  const level = (v) => (v == null ? null : v >= 0.95 ? 'good' : v >= 0.85 ? 'warn' : 'bad');

  class Report {
    constructor(root) {
      this.root = root;
      this.cfg = JSON.parse(root.dataset.config);
      GX.setMessages(this.cfg.messages);
      this.baselineId = GX.urlParam('baseline') ?? '';
      this.mode = 'chart';
      window.addEventListener('resize', () => { if (this.data) this.renderChart(); });
      this.load();
    }

    async load() {
      const q = this.baselineId ? `?baseline_id=${encodeURIComponent(this.baselineId)}` : '';
      this.root.classList.add('busy');
      try {
        const res = await fetch(this.cfg.evmUrl + q, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        this.data = await res.json();
        this.baselineId = this.data.baseline_id;
        this.render();
      } catch (e) {
        GX.toast(T('load_failed') + e.message, true);
      } finally {
        this.root.classList.remove('busy');
      }
    }

    // ---------------------------------------------------------------- formatting
    year() { return GX.dt(GX.toDay(this.data.today)).getUTCFullYear(); }
    day(s) { return s ? GX.fmtDay(GX.toDay(s), this.year()) : T('no_value'); }
    num(v) {
      if (v == null) return T('no_value');
      const n = (Math.round(v * 10) / 10).toLocaleString();
      return this.data.unit === 'hours' ? `${n}h` : T('days_short', { n });
    }

    render() {
      const d = this.data;
      const plan = el('select', { class: 'gx-select', onchange: (e) => { this.baselineId = e.target.value; GX.setUrlParams({ baseline: this.baselineId }); this.load(); } }, [
        el('option', { value: 'current', text: T('report_plan_current') }),
        ...d.baselines.map((b) => el('option', { value: b.id, text: T('report_plan_baseline', { name: b.name }) })),
      ]);
      plan.value = d.baseline_id;
      const bar = el('div', { class: 'gx-rp-bar' }, [el('label', {}, [T('report_plan'), ' ', plan]),
        this.cfg.scheduleUrl ? el('a', { href: this.cfg.scheduleUrl, text: T('open_schedule') }) : null]);
      if (!d.series.length) {
        this.root.replaceChildren(bar, el('p', { class: 'gx-rp-empty', text: T('evm_empty') }));
        return;
      }
      this.chartBox = el('div', { class: 'gx-rp-chart' });
      const toggle = el('button', { type: 'button', class: 'gx-btn', text: T(this.mode === 'chart' ? 'show_table' : 'show_chart'),
        onclick: () => { this.mode = this.mode === 'chart' ? 'table' : 'chart'; toggle.textContent = T(this.mode === 'chart' ? 'show_table' : 'show_chart'); this.renderChart(); } });
      const legend = el('div', { class: 'gx-rp-legend' }, SERIES.filter((s) => s.key !== 'ac' || d.unit === 'hours').map((s) =>
        el('span', { html: `<svg width="26" height="10" aria-hidden="true"><line x1="1" y1="5" x2="25" y2="5" stroke="${s.color}" stroke-width="2" stroke-dasharray="${s.dash}" stroke-linecap="round"/></svg>${esc(T(s.label))}` })));
      this.root.replaceChildren(...[
        bar,
        this.tiles(),
        d.unit === 'days' ? el('p', { class: 'gx-rp-note', text: T('evm_days_note') }) : null,
        d.excluded ? el('p', { class: 'gx-rp-note', text: T('evm_excluded', { n: d.excluded }) }) : null,
        el('section', { class: 'gx-rp-card' }, [
          el('div', { class: 'gx-rp-card-head' }, [el('h3', { text: T('chart_title', { unit: T(d.unit === 'hours' ? 'unit_hours' : 'unit_days') }) }), legend, toggle]),
          this.chartBox,
          el('p', { class: 'gx-rp-help', text: T('evm_help') }),
        ].filter(Boolean)),
        this.phaseTable(),
      ].filter(Boolean));
      this.renderChart();
    }

    tile(label, value, sub, status, statusText) {
      return el('div', { class: 'gx-rp-tile' }, [
        el('div', { class: 'gx-rp-tile-label', text: label }),
        el('div', { class: 'gx-rp-tile-value', text: value }),
        sub ? el('div', { class: 'gx-rp-tile-sub', text: sub }) : null,
        status ? el('span', { class: `gx-rp-status ${status}`, html: `<i aria-hidden="true">${STATUS_ICON[status]}</i>${esc(statusText)}` }) : null,
      ]);
    }

    tiles() {
      const n = this.data.now, unitDays = this.data.unit === 'days';
      const spi = level(n.spi), cpi = level(n.cpi);
      let delay = '';
      if (n.forecast && n.finish) {
        const a = GX.toDay(n.finish), b = GX.toDay(n.forecast), diff = b - a;
        delay = diff === 0 ? T('on_schedule') : T(diff > 0 ? 'n_days_late' : 'n_days_early', { n: Math.abs(diff) });
      }
      const vac = n.vac == null ? '' : n.vac < 0 ? T('over_n', { n: this.num(-n.vac) }) : T('under_n', { n: this.num(n.vac) });
      return el('div', { class: 'gx-rp-tiles' }, [
        this.tile(T('tile_progress'), `${n.progress}%`, T('tile_progress_sub', { p: n.planned_progress })),
        this.tile(T('tile_spi'), n.spi == null ? T('no_value') : n.spi.toFixed(2), null, spi, spi && T(`spi_${spi}`)),
        unitDays ? null : this.tile(T('tile_cpi'), n.cpi == null ? T('no_value') : n.cpi.toFixed(2), null, cpi, cpi && T(`cpi_${cpi}`)),
        this.tile(T('tile_forecast'), n.forecast ? this.day(n.forecast) : (n.progress >= 100 ? T('tile_forecast_done') : T('no_value')),
          T('tile_forecast_sub', { d: this.day(n.finish), n: delay || T('no_value') })),
        unitDays ? null : this.tile(T('tile_eac'), this.num(n.eac), T('tile_eac_sub', { bac: this.num(this.data.bac), d: vac || T('no_value') })),
      ].filter(Boolean));
    }

    // ---------------------------------------------------------------- chart / table
    renderChart() {
      const box = this.chartBox;
      if (!box) return;
      const d = this.data, series = SERIES.filter((s) => s.key !== 'ac' || d.unit === 'hours');
      if (this.mode === 'table') {
        const head = `<tr><th>${esc(T('col_date'))}</th>${series.map((s) => `<th>${esc(T(s.label))}</th>`).join('')}</tr>`;
        const rows = d.series.map((p) => `<tr><td>${esc(this.day(p.date))}</td>${series.map((s) => `<td class="n">${p[s.key] == null ? '' : esc(this.num(p[s.key]))}</td>`).join('')}</tr>`).join('');
        box.innerHTML = `<div class="gx-rp-table-wrap"><table class="gx-rp-table">${head}${rows}</table></div>`;
        return;
      }
      const W = Math.max(480, box.clientWidth), H = 300, M = { l: 64, r: 128, t: 14, b: 30 };
      const pts = d.series.map((p) => ({ ...p, x: GX.toDay(p.date) }));
      const x0 = pts[0].x, x1 = Math.max(pts.at(-1).x, x0 + 1);
      const ymax = niceMax(Math.max(d.bac, ...pts.flatMap((p) => series.map((s) => p[s.key] ?? 0))));
      const X = (v) => M.l + (v - x0) / (x1 - x0) * (W - M.l - M.r), Y = (v) => H - M.b - v / ymax * (H - M.t - M.b);
      const out = [];
      // grid and y axis
      for (let i = 0; i <= 4; i++) {
        const v = ymax / 4 * i, y = Y(v);
        out.push(`<line class="grid" x1="${M.l}" x2="${W - M.r}" y1="${y}" y2="${y}"/><text class="ax" x="${M.l - 8}" y="${y + 4}" text-anchor="end">${esc(this.num(v))}</text>`);
      }
      // x axis: months (or weeks for short projects)
      const ticks = monthTicks(x0, x1, (x1 - x0) < 70, W - M.l - M.r);
      for (const t of ticks) out.push(`<text class="ax" x="${X(t.d)}" y="${H - M.b + 18}" text-anchor="middle">${esc(t.label)}</text><line class="tick" x1="${X(t.d)}" x2="${X(t.d)}" y1="${H - M.b}" y2="${H - M.b + 4}"/>`);
      out.push(`<line class="base" x1="${M.l}" x2="${W - M.r}" y1="${Y(0)}" y2="${Y(0)}"/>`);
      // budget, today, planned finish
      out.push(`<line class="ref" x1="${M.l}" x2="${W - M.r}" y1="${Y(d.bac)}" y2="${Y(d.bac)}"/><text class="ref-t" x="${M.l + 4}" y="${Y(d.bac) - 5}">${esc(T('col_bac'))} ${esc(this.num(d.bac))}</text>`);
      const today = GX.toDay(d.today), fin = GX.toDay(d.finish);
      if (today >= x0 && today <= x1) out.push(`<line class="today" x1="${X(today)}" x2="${X(today)}" y1="${M.t}" y2="${H - M.b}"/><text class="mark-t" x="${X(today) + 4}" y="${M.t + 10}">${esc(T('today'))}</text>`);
      if (fin >= x0 && fin <= x1 && fin !== today) out.push(`<line class="ref" x1="${X(fin)}" x2="${X(fin)}" y1="${M.t}" y2="${H - M.b}"/><text class="mark-t" x="${X(fin) - 4}" y="${M.t + 10}" text-anchor="end">${esc(T('planned_finish'))}</text>`);
      // lines and direct labels at their last point (pushed apart so they never overlap)
      const ends = [];
      for (const s of series) {
        const p = pts.filter((q) => q[s.key] != null);
        if (!p.length) continue;
        out.push(`<path class="line" d="${p.map((q, i) => `${i ? 'L' : 'M'}${X(q.x).toFixed(1)},${Y(q[s.key]).toFixed(1)}`).join('')}" stroke="${s.color}" stroke-dasharray="${s.dash}"/>`);
        const last = p.at(-1);
        ends.push({ s, x: X(last.x), y: Y(last[s.key]), v: last[s.key] });
      }
      ends.sort((a, b) => a.y - b.y);
      for (let i = 1; i < ends.length; i++) ends[i].ly = Math.max(ends[i].y, (ends[i - 1].ly ?? ends[i - 1].y) + 15);
      for (const e of ends) {
        const ly = e.ly ?? e.y;
        out.push(`<line x1="${e.x + 4}" x2="${e.x + 14}" y1="${ly}" y2="${ly}" stroke="${e.s.color}" stroke-width="2" stroke-dasharray="${e.s.dash}"/>`
          + `<text class="end-t" x="${e.x + 18}" y="${ly + 4}">${esc(T(e.s.label))} ${esc(this.num(e.v))}</text>`);
      }
      // hover layer: crosshair, markers and a tooltip for the nearest point
      out.push(`<g class="hover" visibility="hidden"><line class="cross" y1="${M.t}" y2="${H - M.b}"/>${series.map((s) => `<circle r="4" fill="${s.color}" data-k="${s.key}"/>`).join('')}</g>`);
      out.push(`<rect class="hit" x="${M.l}" y="${M.t}" width="${W - M.l - M.r}" height="${H - M.t - M.b}"/>`);
      box.innerHTML = `<svg class="gx-rp-svg" width="${W}" height="${H}" role="img" aria-label="${esc(T('chart_title', { unit: '' }))}">${out.join('')}</svg><div class="gx-rp-tip" hidden></div>`;
      const svg = box.querySelector('svg'), g = svg.querySelector('.hover'), tip = box.querySelector('.gx-rp-tip');
      svg.querySelector('.hit').addEventListener('mousemove', (e) => {
        const r = svg.getBoundingClientRect(), mx = e.clientX - r.left;
        const p = pts.reduce((a, b) => (Math.abs(X(b.x) - mx) < Math.abs(X(a.x) - mx) ? b : a));
        const cx = X(p.x);
        g.setAttribute('visibility', 'visible');
        const cross = g.querySelector('.cross');
        cross.setAttribute('x1', cx); cross.setAttribute('x2', cx);
        for (const c of g.querySelectorAll('circle')) {
          const v = p[c.dataset.k];
          c.setAttribute('visibility', v == null ? 'hidden' : 'visible');
          if (v != null) { c.setAttribute('cx', cx); c.setAttribute('cy', Y(v)); }
        }
        tip.hidden = false;
        tip.innerHTML = `<b>${esc(this.day(p.date))}</b>${series.map((s) => (p[s.key] == null ? '' : `<div><i style="background:${s.color}"></i>${esc(T(s.label))}<span>${esc(this.num(p[s.key]))}</span></div>`)).join('')}`;
        tip.style.left = `${Math.min(cx + 12, W - tip.offsetWidth - 4)}px`;
        tip.style.top = `${M.t + 8}px`;
      });
      svg.querySelector('.hit').addEventListener('mouseleave', () => { g.setAttribute('visibility', 'hidden'); tip.hidden = true; });
    }

    phaseTable() {
      const rows = this.data.phases.map((p) => {
        const st = level(p.spi);
        return `<tr><td>${esc(p.subject)}</td><td>${esc(GX.range(this.day(p.start), this.day(p.finish)))}</td><td class="n">${esc(this.num(p.bac))}</td>`
          + `<td class="n">${esc(this.num(p.pv))}</td><td class="n">${esc(this.num(p.ev))}</td><td class="n">${p.progress}%</td>`
          + `<td class="n">${p.spi == null ? T('no_value') : p.spi.toFixed(2)}${st ? ` <span class="gx-rp-status small ${st}"><i aria-hidden="true">${STATUS_ICON[st]}</i>${esc(T(`spi_${st}`))}</span>` : ''}</td></tr>`;
      }).join('');
      const head = ['col_phase', 'period_col', 'col_bac', 'col_pv', 'col_ev', 'col_progress', 'col_spi'].map((k) => `<th>${esc(T(k))}</th>`).join('');
      return el('section', { class: 'gx-rp-card' }, [el('h3', { text: T('phases_title') }),
        el('div', { class: 'gx-rp-table-wrap', html: `<table class="gx-rp-table"><tr>${head}</tr>${rows}</table>` })]);
    }
  }

  // round the axis maximum up to a value that divides into 4 readable ticks
  const niceMax = (v) => {
    if (!(v > 0)) return 1;
    const p = 10 ** Math.floor(Math.log10(v)), f = v / p;
    return ([1, 1.2, 1.6, 2, 2.4, 3, 4, 5, 6, 8, 10].find((m) => f <= m) ?? 10) * p;
  };
  // ticks every 1, 2, 3, 6 or 12 months, as many as fit the width; January also shows the year
  const monthTicks = (a, b, weekly, width) => {
    const out = [];
    if (weekly) {
      for (let d = a; d <= b; d++) {
        const x = GX.dt(d);
        if (x.getUTCDay() === 1) out.push({ d, label: `${x.getUTCMonth() + 1}/${x.getUTCDate()}` });
      }
      return out;
    }
    const months = (b - a) / 30.4, fit = Math.max(1, Math.floor(width / 64));
    const step = [1, 2, 3, 6, 12].find((n) => months / n <= fit) ?? 12;
    // from the first month boundary in the period that is a multiple of the step (Jan, Apr, Jul, Oct for 3)
    const s = GX.dt(a);
    let m0 = s.getUTCMonth() + 1 + (s.getUTCDate() > 1 ? 1 : 0);
    while ((m0 - 1) % step) m0++;
    for (let y = s.getUTCFullYear(), m = m0; ; m += step) {
      while (m > 12) { m -= 12; y++; }
      const d = GX.toDay(`${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-01`);
      if (d > b) break;
      if (d < a) continue;
      out.push({ d, label: step === 12 ? String(y) : m === 1 || !out.length ? GX.fmtYM(y, m) : GX.fmtMonth(m) });
    }
    return out;
  };

  const start = () => {
    const root = document.getElementById('gantrix-report');
    if (root) root.report = new Report(root);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
