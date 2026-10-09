/* 工程表 (Schedule) for Redmine (MIT License)
 * portfolio (全体レポート): projects with a signal, period, progress, SPI trend, CPI, overdue
 * tasks and the next milestone; and the workload of assignees per week across those projects. */
(() => {
  'use strict';
  const GX = window.Gantrix;
  const { T, esc, el } = GX;
  const SIGNALS = ['red', 'amber', 'green'];
  const ICON = { red: '✕', amber: '!', green: '✓' };

  class Portfolio {
    constructor(root) {
      this.root = root;
      this.cfg = JSON.parse(root.dataset.config);
      GX.setMessages(this.cfg.messages);
      const saved = GX.store('gantrix-portfolio') ?? {};
      this.tab = this.cfg.tab ?? 'projects'; // each tab has its own URL (/gantrix/portfolio, /gantrix/workload)
      this.parent = saved.parent ?? '';
      this.signals = new Set(saved.signals ?? []);
      this.expanded = new Set();
      window.addEventListener('popstate', () => {
        this.tab = location.pathname.endsWith(this.cfg.pages.workload) ? 'workload' : 'projects';
        this.render();
      });
      this.render();
    }

    save() { GX.store('gantrix-portfolio', { parent: this.parent, signals: [...this.signals] }); }

    async fetch(url) {
      this.root.classList.add('busy');
      try {
        const res = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } catch (e) {
        GX.toast(T('load_failed') + e.message, true);
        return null;
      } finally {
        this.root.classList.remove('busy');
      }
    }

    year() { return GX.dt(GX.toDay((this.projects ?? this.workload)?.today ?? new Date().toISOString())).getUTCFullYear(); }
    day(s, withWeekday = false) {
      if (!s) return '-';
      const d = GX.toDay(s), x = GX.dt(d);
      return withWeekday ? GX.fmtDay(d, this.year()) : (x.getUTCFullYear() === this.year() ? `${x.getUTCMonth() + 1}/${x.getUTCDate()}` : `${String(x.getUTCFullYear()).slice(2)}/${x.getUTCMonth() + 1}/${x.getUTCDate()}`);
    }
    url(tpl, p) { return tpl.replace('__id__', encodeURIComponent(p.identifier)); }

    async render() {
      const tabs = el('div', { class: 'gx-pf-tabs', role: 'tablist' }, ['projects', 'workload'].map((t) => el('button', {
        type: 'button', role: 'tab', class: this.tab === t ? 'on' : '', 'aria-selected': String(this.tab === t), text: T(`portfolio_tab_${t}`),
        onclick: () => { if (this.tab === t) return; this.tab = t; history.pushState({ tab: t }, '', this.cfg.pages[t]); this.render(); },
      })));
      this.body = el('div', { class: 'gx-pf-body' });
      this.root.replaceChildren(tabs, this.body);
      if (this.tab === 'projects') {
        this.projects ??= await this.fetch(this.cfg.dataUrl);
        if (this.projects) this.renderProjects();
      } else {
        this.workload ??= await this.fetch(this.cfg.workloadUrl);
        if (this.workload) this.renderWorkload();
      }
    }

    // ---------------------------------------------------------------- projects
    renderProjects() {
      const d = this.projects;
      const inParent = d.projects.filter((p) => !this.parent || p.parent === this.parent);
      const rows = inParent.filter((p) => !this.signals.size || this.signals.has(p.signal));
      const counts = Object.fromEntries(SIGNALS.map((s) => [s, inParent.filter((p) => p.signal === s).length]));
      const parentSel = d.parents.length ? el('select', { class: 'gx-select', onchange: (e) => { this.parent = e.target.value; this.save(); this.renderProjects(); } },
        [el('option', { value: '', text: T('portfolio_all_parents') }), ...d.parents.map((p) => el('option', { value: p.name, text: p.name }))]) : null;
      if (parentSel) parentSel.value = this.parent;
      const chips = SIGNALS.map((s) => el('button', {
        type: 'button', class: `gx-pf-sig-chip ${s}${this.signals.has(s) ? ' on' : ''}`, 'aria-pressed': String(this.signals.has(s)),
        html: `<i aria-hidden="true">${ICON[s]}</i>${esc(T(`signal_${s}`))} <b>${counts[s]}</b>`,
        onclick: () => { if (this.signals.has(s)) this.signals.delete(s); else this.signals.add(s); this.save(); this.renderProjects(); },
      }));
      const t = d.thresholds;
      const table = rows.length ? el('div', { class: 'gx-pf-table-wrap', html: this.projectTable(rows) }) : el('p', { class: 'gx-pf-empty', text: T('portfolio_none') });
      this.body.replaceChildren(
        el('p', { class: 'gx-pf-lead', text: T('portfolio_lead', { d: this.day(d.today, true) }) }),
        el('div', { class: 'gx-pf-filters' }, [parentSel ? el('label', {}, [T('portfolio_parent'), ' ', parentSel]) : null, ...chips,
          el('a', { class: 'gx-btn gx-pf-csv', href: this.cfg.csvUrl, text: T('portfolio_csv') })].filter(Boolean)),
        table,
        el('p', { class: 'gx-pf-criteria', text: T('portfolio_criteria', { red: t.red, amber: t.amber, overdue: t.overdue }) }),
      );
    }

    projectTable(rows) {
      const today = GX.toDay(this.projects.today);
      const head = ['', 'col_project', 'col_pm', 'col_period', 'col_progress_pa', 'col_spi_trend', 'col_cpi', 'col_overdue', 'col_next_milestone']
        .map((k) => `<th>${k ? esc(T(k)) : ''}</th>`).join('');
      const body = rows.map((p) => {
        const sig = `<span class="gx-pf-sig ${p.signal}" title="${esc(T(`signal_${p.signal}`))}"><i aria-hidden="true">${ICON[p.signal]}</i><span class="sr">${esc(T(`signal_${p.signal}`))}</span></span>`;
        const name = `<a class="gx-pf-name" href="${esc(this.url(this.cfg.reportUrl, p))}">${esc(p.name)}</a><a class="gx-pf-open" href="${esc(this.url(this.cfg.projectUrl, p))}">${esc(T('open_schedule'))}</a>`;
        let period = '-';
        if (p.start && p.finish) {
          const s = GX.toDay(p.start), f = GX.toDay(p.finish), pos = Math.max(0, Math.min(1, (today - s) / Math.max(1, f - s)));
          period = `<div class="gx-pf-period"><span>${esc(this.day(p.start))}</span><span>${esc(this.day(p.finish))}</span></div><div class="gx-pf-track"><b style="width:100%"></b><i style="left:${(pos * 100).toFixed(1)}%"></i></div>`;
        }
        const prog = p.has_plan
          ? `<div class="gx-pf-prog"><span class="gx-pf-bar plan"><b style="width:${p.planned_progress}%"></b></span><span>${p.planned_progress}%</span><span class="gx-pf-bar act"><b style="width:${p.progress}%"></b></span><b>${p.progress}%</b></div>`
          : '-';
        const trend = p.trend.length > 1 ? sparkline(p.trend, p.signal) : '';
        const ms = p.milestone
          ? `<div class="gx-pf-ms"><b>◆ ${esc(p.milestone.name)}</b>${p.milestone.late_days > 0 ? ` <span class="gx-pf-late">${esc(T('milestone_late', { n: p.milestone.late_days }))}</span>` : ''}</div><div class="gx-pf-ms-sub">${esc(T('paren', { text: this.day(p.milestone.date, true), note: T('days_left', { n: p.milestone.days_left }) }))}</div>`
          : '-';
        return `<tr class="${p.signal}"><td>${sig}</td><td>${name}</td><td>${esc(p.managers.join(T('list_sep')) || '-')}</td><td class="gx-pf-pcell">${period}</td><td>${prog}</td>`
          + `<td class="gx-pf-trend">${trend}<b>${p.spi == null ? '-' : p.spi.toFixed(2)}</b></td><td class="n">${p.cpi == null ? '-' : p.cpi.toFixed(2)}</td>`
          + `<td class="n${p.overdue ? ' bad' : ''}">${esc(T('count_n', { n: p.overdue }))}</td><td>${ms}</td></tr>`;
      }).join('');
      return `<table class="gx-pf-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
    }

    // ---------------------------------------------------------------- workload
    renderWorkload() {
      const d = this.workload, n = d.weeks.length;
      const first = this.day(d.weeks[0]), last = this.day(GX.toStr(GX.toDay(d.weeks[n - 1]) + 6));
      const head = `<tr><th>${esc(T('col_assignee'))}</th>${d.weeks.map((w) => `<th>${esc(T('week_of', { d: this.day(w) }))}</th>`).join('')}</tr>`;
      const rows = [];
      for (const r of d.rows) {
        const open = this.expanded.has(r.id);
        rows.push(`<tr class="gx-pf-user"><th><button type="button" class="gx-pf-tog" data-user="${r.id}" aria-expanded="${open}">${open ? '▾' : '▸'}</button>${esc(r.name)}</th>${r.cells.map((c, i) => {
          const p = d.capacity[i] ? Math.round(c.hours / d.capacity[i] * 100) : 0;
          if (!c.hours) return '<td></td>';
          const lv = p > 100 ? 'over' : p > 90 ? 'l3' : p > 50 ? 'l2' : 'l1';
          return `<td><button type="button" class="gx-pf-cell ${lv}" data-user="${r.id}" data-week="${i}" title="${esc(T('load_tip', { h: c.hours, cap: d.capacity[i], p }))}">${p}%</button></td>`;
        }).join('')}</tr>`);
        if (open) {
          for (const p of r.projects) {
            rows.push(`<tr class="gx-pf-sub"><th>${esc(p.name)}</th>${p.hours.map((h, i) => `<td>${h ? `${Math.round(h / d.capacity[i] * 100)}%` : ''}</td>`).join('')}</tr>`);
          }
        }
      }
      if (d.unassigned) {
        rows.push(`<tr class="gx-pf-user"><th><span class="gx-pf-tog-sp"></span>${esc(T('no_assignee'))}</th>${d.unassigned.cells.map((c, i) =>
          (c.hours ? `<td><button type="button" class="gx-pf-cell none" data-user="" data-week="${i}">${c.hours}h</button></td>` : '<td></td>')).join('')}</tr>`);
      }
      const legend = [['l1', 'legend_50'], ['l2', 'legend_90'], ['l3', 'legend_100'], ['over', 'legend_over'], ['none', 'legend_unassigned']]
        .map(([c, k]) => `<span><i class="gx-pf-cell ${c}"></i>${esc(T(k))}</span>`).join('');
      const wrap = el('div', { class: 'gx-pf-table-wrap', html: d.rows.length || d.unassigned ? `<table class="gx-pf-table gx-pf-load">${head}${rows.join('')}</table>` : `<p class="gx-pf-empty">${esc(T('load_none'))}</p>` });
      this.detail = el('div', { class: 'gx-pf-detail', hidden: true });
      wrap.addEventListener('click', (e) => {
        const tog = e.target.closest('.gx-pf-tog');
        if (tog) { const id = +tog.dataset.user; if (this.expanded.has(id)) this.expanded.delete(id); else this.expanded.add(id); this.renderWorkload(); return; }
        const cell = e.target.closest('button.gx-pf-cell');
        if (cell) this.showWeek(cell.dataset.user, +cell.dataset.week);
      });
      this.body.replaceChildren(
        el('p', { class: 'gx-pf-lead', text: T('workload_lead', { from: first, to: last, n, h: d.hours_per_day }) }),
        wrap,
        el('div', { class: 'gx-pf-legend', html: legend }),
        el('p', { class: 'gx-pf-criteria', text: T('workload_hint') }),
        this.detail,
      );
    }

    // tasks behind one cell
    showWeek(userId, i) {
      const d = this.workload, row = userId ? d.rows.find((r) => String(r.id) === userId) : d.unassigned;
      if (!row) return;
      const items = row.cells[i].tasks.map((id) => d.tasks[id]).map((t) =>
        `<li><a href="${esc(this.url(this.cfg.projectUrl, { identifier: t.project_identifier }))}">${esc(t.project)}</a>${esc(T('path_sep'))}<a href="${esc(`${this.cfg.issuesUrl}/${t.id}`)}">#${t.id} ${esc(t.subject)}</a>`
        + `<span>${esc(GX.range(this.day(t.start_date), this.day(t.due_date)))}${T('gap')}${esc(T('per_day', { h: t.per_day }))}</span></li>`).join('');
      this.detail.hidden = false;
      this.detail.innerHTML = `<h3>${esc(row.name ?? T('no_assignee'))} (${esc(T('week_of', { d: this.day(d.weeks[i]) }))})</h3><ul>${items}</ul>`;
      this.detail.scrollIntoView({ block: 'nearest' });
    }
  }

  // SPI over the last weeks: a 2px line with the latest point marked; 1.0 as a dotted reference
  const sparkline = (values, signal) => {
    const W = 88, H = 24, lo = Math.min(0.6, ...values), hi = Math.max(1.1, ...values);
    const x = (i) => 2 + i * (W - 6) / (values.length - 1), y = (v) => H - 3 - (v - lo) / (hi - lo) * (H - 6);
    const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    return `<svg class="gx-pf-spark ${signal}" width="${W}" height="${H}" aria-hidden="true"><line x1="0" x2="${W}" y1="${y(1)}" y2="${y(1)}" class="ref"/>`
      + `<polyline points="${pts}"/><circle cx="${x(values.length - 1)}" cy="${y(values.at(-1))}" r="2.5"/></svg>`;
  };

  const start = () => {
    const root = document.getElementById('gantrix-portfolio');
    if (root) root.portfolio = new Portfolio(root);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
