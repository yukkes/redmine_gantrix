/* 工程表 (Schedule) for Redmine (MIT License)
 * app: data loading, columns, edits -> batch API, undo / redo, toolbar, menus, dialogs. */
(() => {
  'use strict';
  const GX = window.Gantrix;
  const { T, esc, el } = GX;
  const RH = 28;
  const OPTIONAL = ['id', 'status', 'est', 'spent', 'astart', 'aend', 'preds', 'slack'];
  const OPTIONAL_TITLE = { id: 'col_id', status: 'col_status', est: 'col_est', spent: 'col_spent', astart: 'col_actual_start', aend: 'col_actual_end', preds: 'col_preds', slack: 'col_slack' };

  // printable area of landscape paper with 10mm margins (mm)
  const PAPERS = { a4: { size: 'A4', w: 277, h: 190 }, a3: { size: 'A3', w: 400, h: 277 } };
  const fmtH = (v) => `${Math.round(v * 10) / 10}h`;
  const btn = (label, title, onclick, cls = '') => el('button', { type: 'button', class: `gx-btn ${cls}`, title, onclick }, [label]);
  // an icon with a label, or an icon alone (then the title is also its accessible name)
  const ibtn = (icon, label, title, onclick, cls = '') => el('button', {
    type: 'button', class: `gx-btn ${label ? '' : 'icon '}${cls}`, title, 'aria-label': label ? null : title, onclick,
  }, [GX.icon(icon), label && el('span', { text: label })]);

  class App {
    constructor(root) {
      this.root = root;
      this.cfg = JSON.parse(root.dataset.config);
      GX.setMessages(this.cfg.messages);
      this.key = `gantrix-schedule:${this.cfg.project}`;
      // logged-in users get their settings from the server (null for anonymous users)
      const saved = this.cfg.view ?? GX.store(this.key) ?? {};
      this.zoom = saved.zoom ?? 'day';
      this.collapsed = saved.collapsed ?? {};
      // "all", or "in progress" (the default): the other tasks are loaded when their parent is unfolded
      this.showClosed = !!saved.showClosed;
      this.opened = new Set(saved.opened ?? []);
      this.openAll = false; // "expand all" in progress view: everything loaded until the next change of view
      this.inazuma = saved.inazuma !== false;
      this.baselineId = saved.baselineId ?? '';
      this.extraCols = saved.extraCols ?? ['preds'];
      this.queryId = saved.queryId ?? null;
      // a shared link wins over the saved settings
      if (GX.urlParam('query_id') != null) this.queryId = +GX.urlParam('query_id') || null;
      if (GX.urlParam('baseline') != null) this.baselineId = GX.urlParam('baseline');
      this.critical = !!saved.critical;
      this.loadPane = !!saved.loadPane;
      this.preview = null; // Map id -> [s, e] while the reschedule dialog shows its preview
      this.undoStack = [];
      this.redoStack = [];
      this.build();
      this.load();
    }

    save() {
      const { zoom, collapsed, showClosed, inazuma, baselineId, extraCols, queryId, critical, loadPane } = this;
      const view = { zoom, collapsed, showClosed, inazuma, baselineId, extraCols, queryId, critical, loadPane, opened: [...this.opened] };
      GX.store(this.key, view);
      GX.setUrlParams({ query_id: queryId, baseline: baselineId });
      if (!this.cfg.view) return;
      // several quick changes (e.g. collapsing rows) become one request
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => GX.api(this.cfg.baseUrl, 'PUT', '/preferences', { preferences: view }).catch(() => {}), 800);
    }
    // busy while any request (or save + reload sequence) is running
    busy(delta) {
      this.pending = (this.pending ?? 0) + delta;
      this.root.classList.toggle('busy', this.pending > 0);
    }
    async api(method, path, body) {
      this.busy(1);
      try { return await GX.api(this.cfg.baseUrl, method, path, body); } finally { this.busy(-1); }
    }

    // ---------------------------------------------------------------- load & model
    async load(keep = false) {
      const q = new URLSearchParams();
      if (this.baselineId) q.set('baseline_id', this.baselineId);
      if (this.queryId) q.set('query_id', this.queryId);
      if (this.showClosed) q.set('closed', '1');
      else if (this.openAll) q.set('open', 'all');
      else if (this.opened.size) q.set('open', [...this.opened].join(','));
      const url = `${this.cfg.dataUrl}${q.toString() ? `?${q}` : ''}`;
      this.busy(1);
      try {
        const res = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        // keep the selection the user has *now* (it may have changed while loading)
        const g = this.grid;
        this.setData(json, keep ? { id: g.rows[g.sel.r]?.id, c: g.sel.c, newRow: g.isNewRow(g.sel.r) } : null);
      } catch (e) {
        GX.toast(T('load_failed') + e.message, true);
      } finally {
        this.busy(-1);
        if (this.root.classList.contains('gx-loading')) {
          this.root.classList.remove('gx-loading');
          this.resize();
          // the grid was hidden until now and could not scroll, so open it a week before today here
          if (this.data) this.scrollToDay(this.today - 7);
        }
      }
    }

    setData(data, sel) {
      data.tasks = GX.expandRows(data.tasks);
      this.data = data;
      this.cal = new GX.Calendar(data.calendar);
      this.today = GX.toDay(data.today);
      this.baseDay = this.today;
      this.byId = {};
      // WBS numbers come from the server, numbered over all tasks: they stay the same whatever is shown
      this.wbsById = {};
      for (const t of data.tasks) {
        Object.assign(t, { s: GX.toDay(t.start_date), e: GX.toDay(t.due_date), as: GX.toDay(t.actual_start_date),
                           ae: GX.toDay(t.actual_end_date), children: [], preds: [] });
        this.byId[t.id] = t;
        this.wbsById[t.id] = t.wbs;
      }
      Object.assign(this.wbsById, data.hidden_wbs ?? {});
      this.idByWbs = {};
      for (const [id, wbs] of Object.entries(this.wbsById)) this.idByWbs[wbs] = +id;
      for (const r of data.relations) this.byId[r.to]?.preds.push(r.from);
      this.roots = [];
      for (const t of data.tasks) (this.byId[t.parent_id]?.children ?? this.roots).push(t);
      const order = (list) => {
        list.sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9) || (a.s ?? 1e9) - (b.s ?? 1e9) || a.id - b.id);
        list.forEach((t) => order(t.children));
      };
      order(this.roots);
      this.rollUp(this.roots);
      this.baseline = {};
      for (const [k, v] of Object.entries(data.baseline_items ?? {})) this.baseline[k] = [GX.toDay(v[0]), GX.toDay(v[1]), v[2]];
      this.statusById = Object.fromEntries((data.statuses ?? []).map((s) => [s.id, s]));
      this.refreshToolbar();
      this.buildRows();
      this.setupTimeline();
      this.grid.setColumns(this.columns());
      this.grid.setRows(this.rows);
      this.grid.render();
      this.renderSummary();
      if (sel) {
        const idx = sel.newRow ? this.rows.length : this.rowIndex[sel.id];
        if (idx != null) {
          Object.assign(this.grid.sel, { r: idx, ar: idx, c: sel.c, ac: sel.c });
          this.grid.clampSel();
          this.grid.refresh();
        }
      }
      this.grid.focus();
    }

    // folded: by the user, or its subtasks are not loaded yet (t.more)
    isFolded(t) { return !!this.collapsed[t.id] || (t.more && !t.children.length); }
    // unfolding a task whose subtasks are not loaded loads them; folding it again stops loading them
    toggle(t) {
      if (t.more && !t.children.length) {
        this.opened.add(t.id);
        delete this.collapsed[t.id];
        this.save();
        this.load(true);
        return;
      }
      if (this.collapsed[t.id]) delete this.collapsed[t.id];
      else { this.collapsed[t.id] = true; this.opened.delete(t.id); }
      this.save();
      this.buildRows();
      this.grid.setRows(this.rows);
      this.grid.render();
    }

    // a parent in Redmine, even when all its subtasks are closed tasks left out of the screen
    isLeaf(t) { return !t.children.length && !t.hidden; }

    // parents get dates, progress (weighted by working days) and hours from their subtasks, including
    // the closed ones not loaded (t.hidden: their totals from the server, see GantrixController#hidden_leaves)
    rollUp(list) {
      const lo = (a, b) => (a == null ? b : b == null ? a : Math.min(a, b));
      const hi = (a, b) => (a == null ? b : b == null ? a : Math.max(a, b));
      for (const t of list) {
        if (this.isLeaf(t)) {
          t.w = this.cal.workingDays(t.s, t.e);
          t.progress = t.done_ratio;
          t.sum = { s: t.s, e: t.e, as: t.as, ae: t.ae, allEnded: t.ae != null, w: t.w, wd: t.w * t.done_ratio,
                    est: +t.estimated_hours || 0, spent: +t.spent_hours || 0 };
          continue;
        }
        this.rollUp(t.children);
        const h = t.hidden;
        const a = h
          ? { s: GX.toDay(h[0]), e: GX.toDay(h[1]), as: GX.toDay(h[2]), ae: GX.toDay(h[3]), allEnded: h[4], w: h[5], wd: h[6], est: h[7], spent: h[8] }
          : { s: null, e: null, as: null, ae: null, allEnded: true, w: 0, wd: 0, est: 0, spent: 0 };
        for (const { sum: x } of t.children) {
          Object.assign(a, { s: lo(a.s, x.s), e: hi(a.e, x.e), as: lo(a.as, x.as), ae: hi(a.ae, x.ae), allEnded: a.allEnded && x.allEnded });
          a.w += x.w;
          a.wd += x.wd;
          a.est += x.est;
          a.spent += x.spent;
        }
        t.sum = a;
        if (this.data.parent_dates_derived) {
          t.s = a.s;
          t.e = a.e;
        }
        t.as = a.as;
        t.ae = a.allEnded ? a.ae : null;
        t.w = a.w;
        t.progress = t.w ? Math.round(a.wd / t.w) : 0;
        t.est_total = a.est;
        t.spent_total = a.spent;
      }
    }

    buildRows() {
      const out = [], base = this.baseDay;
      const walk = (list, level) => {
        for (const t of list) {
          const leaf = this.isLeaf(t);
          const late = leaf && t.done_ratio < 100 && t.e != null && t.e < base;
          const behind = leaf && !late && t.s != null && t.e != null && t.s <= base &&
            t.done_ratio < Math.floor(this.cal.elapsed(t.s, t.e, base) / t.w * 100);
          const collapsed = this.isFolded(t);
          out.push({ id: t.id, task: t, level, wbs: this.wbsById[t.id], hasChildren: !leaf, collapsed,
                     progress: t.progress, days: t.s != null && t.e != null ? t.w : null, late, behind });
          if (!collapsed) walk(t.children, level + 1);
        }
      };
      walk(this.roots, 0);
      this.rows = out;
      this.rowIndex = Object.fromEntries(out.map((r, i) => [r.id, i]));
    }

    // ---------------------------------------------------------------- columns
    columns() {
      const d = this.data, p = d.permissions, year = GX.dt(this.today).getUTCFullYear();
      const leafEditable = (perm) => (row) => perm && !row.hasChildren;
      const datesEditable = (row) => p.edit_issues && !(row.hasChildren && d.parent_dates_derived);
      const whyParent = () => T('parent_derived');
      const slash = (v) => (v == null ? '' : GX.toStr(v).replaceAll('-', '/'));
      const dateCol = (key, title, get, group, editable, clearable) => ({
        key, title, group, editable, clearable, width: 82, align: 'c', editor: 'date', whyReadonly: whyParent,
        text: (row) => GX.fmtDay(get(row.task), year),
        editText: (row) => slash(get(row.task)),
        copyText: (row) => slash(get(row.task)),
        parse: (text, row) => {
          if (!String(text).trim()) return clearable ? { value: null } : { error: T('date_required') };
          const v = GX.parseDate(text, get(row.task) ?? this.today);
          return v == null ? { error: T('date_invalid') } : { value: v };
        },
        cls: (row) => (key === 'end' && row.late ? 'late' : ''),
      });
      // row numbers and WBS numbers get the width they need (5-digit row numbers, deep WBS numbers);
      // a WBS number deeper than WBS_CHARS shows its end ("…1.1.1"), the whole number on hover
      const WBS_CHARS = 12;
      let wbsLen = 0;
      for (const t of d.tasks) if (t.wbs && t.wbs.length > wbsLen) wbsLen = t.wbs.length;
      const shortWbs = (wbs) => {
        if (!wbs || wbs.length <= WBS_CHARS) return wbs ?? '';
        const parts = wbs.split('.');
        let tail = parts.pop();
        while (parts.length && tail.length + parts.at(-1).length + 2 <= WBS_CHARS) tail = `${parts.pop()}.${tail}`;
        return `…${tail.length < WBS_CHARS ? tail : tail.slice(1 - WBS_CHARS)}`;
      };
      const cols = [
        { key: 'rownum', title: '', width: Math.max(36, String(d.tasks.length + 1).length * 7 + 12), align: 'r', header: true, text: (row, r) => r + 1 },
        { key: 'wbs', title: T('col_wbs'), width: Math.max(46, Math.min(wbsLen, WBS_CHARS) * 7 + 12), align: 'c', text: (row) => row.wbs,
          html: (row) => (row.wbs && row.wbs.length > WBS_CHARS ? `<span title="${esc(row.wbs)}">${esc(shortWbs(row.wbs))}</span>` : esc(row.wbs ?? '')),
          editable: () => false, whyReadonly: () => T('wbs_auto') },
        { key: 'subject', title: T('col_task'), width: 220, editor: 'text',
          text: (row) => row.task.subject,
          html: (row) => {
            const t = row.task;
            const tog = t.children.length || t.more ? `<span class="gx-tog">${GX.iconHtml(row.collapsed ? 'chevron-right' : 'chevron-down')}</span>` : '<span class="gx-tog-sp"></span>';
            return `<span class="gx-ind" style="width:${row.level * 14}px"></span>${tog}<span class="gx-subj${row.hasChildren ? ' parent' : ''}${t.closed ? ' closed' : ''}">${esc(t.subject)}</span>${this.openLink(row.id)}`;
          },
          cls: () => 'has-open',
          editable: () => p.edit_issues,
          parse: (text) => (String(text).trim() ? { value: String(text).trim() } : { error: T('subject_required') }) },
        { key: 'assignee', title: T('col_assignee'), width: 78, editor: 'list', clearable: true,
          text: (row) => (row.task.assigned_to ?? '').split(' ')[0],
          editText: (row) => row.task.assigned_to ?? '',
          options: () => d.users.map((u) => ({ label: u.name, value: u.id })),
          editable: leafEditable(p.edit_issues), whyReadonly: whyParent,
          parse: (text) => {
            const q = String(text).trim();
            if (!q) return { value: '' };
            const flat = (s) => s.replace(/\s/g, '');
            const u = d.users.find((x) => x.name === q) ?? d.users.find((x) => flat(x.name) === flat(q)) ?? d.users.find((x) => x.name.startsWith(q));
            return u ? { value: u.id } : { error: T('user_not_found', { name: q }) };
          } },
        dateCol('start', T('col_start'), (t) => t.s, T('group_plan'), datesEditable, false),
        dateCol('end', T('col_end'), (t) => t.e, T('group_plan'), datesEditable, false),
        { key: 'days', title: T('col_days'), width: 56, align: 'r', group: T('group_plan'),
          text: (row) => (row.days == null ? '' : String(row.days)),
          editable: (row) => datesEditable(row) && !row.hasChildren && row.task.s != null, whyReadonly: whyParent,
          parse: (text) => { const n = parseInt(String(text).replace(/[^\d]/g, ''), 10); return n >= 1 ? { value: n } : { error: T('days_invalid') }; } },
        { key: 'progress', title: T('col_progress'), width: 50, align: 'r',
          text: (row) => `${row.progress}%`,
          editText: (row) => String(row.task.done_ratio),
          copyText: (row) => `${row.progress}%`,
          cls: (row) => (row.behind ? 'behind' : ''),
          editable: (row) => p.edit_issues && d.done_ratio_editable && !(row.hasChildren && d.parent_done_ratio_derived), whyReadonly: whyParent,
          parse: (text) => {
            const n = parseInt(String(text).replace(/[^\d]/g, ''), 10);
            return Number.isNaN(n) || n < 0 || n > 100 ? { error: T('progress_invalid') } : { value: n };
          } },
      ];
      const extra = {
        id: { key: 'id', title: '#', width: 50, align: 'r', text: (row) => row.id, html: (row) => this.openLink(row.id, `#${row.id}`),
              editable: () => false, whyReadonly: () => T('id_auto') },
        status: { key: 'status', title: T('col_status'), width: 76, text: (row) => row.task.status ?? '',
                  html: (row) => (row.task.status ? `<i class="gx-st" style="background:${esc(this.data.status_colors?.[row.task.status_id] ?? '#8c959f')}"></i>${esc(row.task.status)}` : ''),
                  editable: () => false, whyReadonly: () => T('status_in_issue') },
        est: { key: 'est', title: T('col_est'), width: 56, align: 'r', group: T('group_hours'), clearable: true,
               text: (row) => { const v = row.hasChildren ? row.task.est_total : row.task.estimated_hours; return v ? fmtH(v) : ''; },
               editable: leafEditable(p.edit_issues), whyReadonly: whyParent,
               parse: (text) => {
                 const q = String(text).replace(/[hH時間\s]/g, '');
                 if (!q) return { value: '' };
                 const n = parseFloat(q);
                 return Number.isNaN(n) || n < 0 ? { error: T('number_invalid') } : { value: n };
               } },
        spent: { key: 'spent', title: T('col_spent'), width: 56, align: 'r', group: T('group_hours'),
                 text: (row) => { const v = row.hasChildren ? row.task.spent_total : row.task.spent_hours; return v ? fmtH(v) : ''; },
                 cls: (row) => { const t = row.task; return !row.hasChildren && t.estimated_hours && t.spent_hours > t.estimated_hours ? 'late' : ''; },
                 editable: () => false, whyReadonly: () => T('spent_from_time_entries') },
        astart: dateCol('astart', T('col_actual_start'), (t) => t.as, T('group_actual'), leafEditable(p.edit), true),
        aend: dateCol('aend', T('col_actual_end'), (t) => t.ae, T('group_actual'), leafEditable(p.edit), true),
        slack: { key: 'slack', title: T('col_slack'), width: 48, align: 'r',
                 text: (row) => (row.task.slack == null ? '' : T('days_short', { n: row.task.slack })),
                 cls: (row) => (row.task.slack != null && row.task.slack <= 0 ? 'crit' : ''),
                 editable: () => false, whyReadonly: () => T('slack_auto') },
        preds: { key: 'preds', title: T('col_preds'), width: 64, clearable: true,
                 text: (row) => row.task.preds.map((id) => this.wbsById[id] ?? `#${id}`).join(','),
                 editable: () => p.manage_relations,
                 parse: (text) => {
                   const ids = [];
                   for (const part of String(text).split(/[,、\s]+/).filter(Boolean)) {
                     const id = part.startsWith('#') ? +part.slice(1) : this.idByWbs[part];
                     if (!id || this.wbsById[id] == null) return { error: T('wbs_not_found', { wbs: part }) };
                     ids.push(id);
                   }
                   return { value: ids.join(',') };
                 } },
      };
      // the issue number goes next to the WBS number, the others after the fixed columns
      if (this.extraCols.includes('id')) cols.splice(cols.findIndex((c) => c.key === 'wbs') + 1, 0, extra.id);
      for (const k of OPTIONAL) if (k !== 'id' && this.extraCols.includes(k)) cols.push(extra[k]);
      if (this.baselineId) {
        cols.push({ key: 'diff', title: T('col_variance'), width: 48, align: 'r',
          text: (row) => {
            const b = this.baseline[row.id], t = row.task;
            if (b?.[1] == null || t.e == null) return '';
            const diff = t.e >= b[1] ? this.cal.workingDays(b[1], t.e) - 1 : -(this.cal.workingDays(t.e, b[1]) - 1);
            return diff === 0 ? '±0' : `${diff > 0 ? '+' : ''}${diff}`;
          },
          cls: (row) => { const b = this.baseline[row.id]; return b?.[1] != null && row.task.e != null && row.task.e > b[1] ? 'late' : ''; },
          editable: () => false, whyReadonly: () => T('variance_auto') });
      }
      return cols;
    }

    // ---------------------------------------------------------------- timeline
    setupTimeline() {
      const ds = [];
      for (const t of this.data.tasks) ds.push(t.s, t.e, t.as, t.ae);
      for (const v of this.data.versions ?? []) ds.push(GX.toDay(v.date));
      // dates far from the rest (9999-12-31, year 3) do not stretch the chart; their bars are cut at its ends
      const [first, last] = GX.focusRange(ds, this.today);
      let lo = first - 14;
      const hi = last + 60;
      lo -= (GX.wday(lo) + 6) % 7;
      if (this.zoom === 'month') { const x = GX.dt(lo); lo = GX.toDay(`${x.getUTCFullYear()}-${x.getUTCMonth() + 1}-01`); }
      this.timeline.ctx = {
        cal: this.cal, today: this.today, baseDay: this.baseDay, firstDay: lo, lastDay: hi, zoom: this.zoom, rowHeight: RH,
        rows: () => this.rows, indexOf: (id) => this.rowIndex[id],
        relations: this.data.relations, baseline: this.baseline, versions: this.data.versions, showInazuma: this.inazuma,
        showCritical: this.critical, preview: this.preview,
        editable: this.data.permissions.edit_issues,
        canLink: this.data.permissions.manage_relations,
        onLink: (from, to) => this.addLink(from, to),
        onDepClick: this.data.permissions.manage_relations ? (rel, e) => this.depMenu(rel, e) : null,
        statusOf: (t) => {
          const s = this.statusById[t.status_id];
          return s ? { name: s.name, kind: s.closed ? 'done' : t.done_ratio > 0 || t.as != null ? 'doing' : 'new', color: this.data.status_colors?.[t.status_id] } : null;
        },
        onBarChange: (row, s, e, mode, wd) => this.onBarChange(row, s, e, mode, wd),
      };
    }
    scrollToDay(d) { this.grid.scroll.scrollLeft = Math.max(0, this.timeline.x(d) - 40); }

    // ---------------------------------------------------------------- edits
    // grid changes -> one PATCH (all rows in one transaction); the inverse is kept for undo
    onEdit(changes) {
      const byTask = new Map();
      for (const ch of changes) {
        if (!byTask.has(ch.row.id)) byTask.set(ch.row.id, {});
        byTask.get(ch.row.id)[ch.key] = ch.value;
      }
      const payload = [], inverse = [], cal = this.cal;
      for (const [id, k] of byTask) {
        const t = this.byId[id], row = {}, inv = { id };
        const set = (field, value, before) => { row[field] = value; if (!(field in inv)) inv[field] = before; };
        if ('subject' in k) set('subject', k.subject, t.subject);
        if ('assignee' in k) set('assigned_to_id', String(k.assignee ?? ''), t.assigned_to_id ? String(t.assigned_to_id) : '');
        if ('start' in k) {
          set('start_date', GX.toStr(k.start), t.start_date ?? '');
          // moving the start keeps the working duration
          if (!('end' in k) && !('days' in k) && t.s != null && t.e != null) set('due_date', GX.toStr(cal.step(cal.nextWorking(k.start), t.w - 1)), t.due_date ?? '');
        }
        if ('end' in k) set('due_date', GX.toStr(k.end), t.due_date ?? '');
        if ('days' in k && t.s != null) set('due_date', GX.toStr(cal.step(cal.nextWorking(k.start ?? t.s), k.days - 1)), t.due_date ?? '');
        if ('progress' in k) {
          set('done_ratio', String(k.progress), String(t.done_ratio));
          // entering progress records the actual dates
          if (k.progress > 0 && t.as == null && !('astart' in k)) set('actual_start_date', GX.toStr(this.today), '');
          if (k.progress === 100 && t.ae == null && !('aend' in k)) set('actual_end_date', GX.toStr(this.today), '');
        }
        if ('est' in k) set('estimated_hours', String(k.est), t.estimated_hours == null ? '' : String(t.estimated_hours));
        if ('astart' in k) set('actual_start_date', GX.toStr(k.astart), t.actual_start_date ?? '');
        if ('aend' in k) set('actual_end_date', GX.toStr(k.aend), t.actual_end_date ?? '');
        if ('preds' in k) set('predecessors', k.preds, t.preds.join(','));
        if (Object.keys(row).length) { payload.push({ id, ...row }); inverse.push(inv); }
      }
      if (payload.length) this.send(payload, inverse, T('updated_n', { n: payload.length }));
    }

    async send(payload, inverse, msg) {
      this.busy(1);
      try {
        await this.api('PATCH', '/tasks', { tasks: payload });
        this.record(this.editStep(payload, inverse));
        GX.toast(msg);
      } catch (e) {
        GX.toast(e.message, true);
      }
      await this.load(true);
      this.busy(-1);
    }

    // ---------------------------------------------------------------- undo / redo
    // Every change is a step that knows how to undo and redo itself, without a limit on their number.
    // Deleted tasks come back from the trash (redmine_issue_trash); without it a delete cannot be undone.
    record(step) {
      this.undoStack.push(step);
      this.redoStack = [];
      this.refreshUndo();
    }
    refreshUndo() {
      if (!this.undoBtn) return;
      this.undoBtn.disabled = this.stepping || !this.undoStack.length;
      this.redoBtn.disabled = this.stepping || !this.redoStack.length;
    }
    undo() { return this.step(this.undoStack, this.redoStack, 'undo'); }
    redo() { return this.step(this.redoStack, this.undoStack, 'redo'); }
    async step(from, to, dir) {
      if (this.stepping) return;
      const s = from.pop();
      if (!s) { GX.toast(T(dir === 'undo' ? 'nothing_to_undo' : 'nothing_to_redo')); return; }
      this.stepping = true;
      this.refreshUndo();
      this.busy(1);
      try {
        await s[dir]();
        to.push(s);
        GX.toast(T(dir === 'undo' ? 'undone' : 'redone'));
      } catch (e) {
        // the tasks changed in another way since (deleted, moved by someone else): the step is dropped
        GX.toast(e.message, true);
      }
      this.stepping = false;
      await this.load(true);
      this.busy(-1);
      this.refreshUndo();
    }
    editStep(payload, inverse) {
      return { undo: () => this.api('PATCH', '/tasks', { tasks: inverse }), redo: () => this.api('PATCH', '/tasks', { tasks: payload }) };
    }
    // dates changed by a reschedule: put back in date order, so a predecessor moves before its successors
    datesStep(changes) {
      const rows = (key) => changes.map((c) => ({ id: c.id, start_date: c[key][0] ?? '', due_date: c[key][1] ?? '' }))
        .sort((a, b) => (a.start_date || '9999').localeCompare(b.start_date || '9999'));
      return { undo: () => this.api('PATCH', '/tasks', { tasks: rows('from') }), redo: () => this.api('PATCH', '/tasks', { tasks: rows('to') }) };
    }
    // deleted tasks: back from the trash, with their time entries; deleted again on redo
    trashStep(tops, ids, times) {
      let entries = times;
      return {
        undo: () => this.api('POST', '/tasks/restore', { ids, time_entries: entries }),
        redo: async () => {
          entries = {};
          for (const id of tops) Object.assign(entries, (await this.api('DELETE', `/tasks/${id}`)).time_entries);
        },
      };
    }
    // added tasks: to the trash on undo (subtasks first), back on redo
    addStep(ids) {
      let entries = {};
      return {
        undo: async () => {
          entries = {};
          for (const id of [...ids].sort((a, b) => b - a)) Object.assign(entries, (await this.api('DELETE', `/tasks/${id}`)).time_entries);
        },
        redo: () => this.api('POST', '/tasks/restore', { ids, time_entries: entries }),
      };
    }
    // moved tasks: each put back where it was (in reverse order), or where it went
    placeStep(moves) {
      const place = (id, at) => this.api('POST', `/tasks/${id}/place`, { parent_id: at.parent_id ?? '', index: at.index });
      return {
        undo: async () => { for (const m of [...moves].reverse()) await place(m.id, m.before); },
        redo: async () => { for (const m of moves) await place(m.id, m.after); },
      };
    }

    async onBarChange(row, s, e, mode, wd) {
      const t = row.task;
      if (!row.hasChildren) {
        this.send([{ id: t.id, start_date: GX.toStr(s), due_date: GX.toStr(e) }],
                  [{ id: t.id, start_date: t.start_date ?? '', due_date: t.due_date ?? '' }], T('updated_n', { n: 1 }));
        return;
      }
      if (!wd) { this.grid.refresh(); return; }
      try {
        const r = await this.api('POST', '/reschedule', { issue_ids: [t.id], days: wd, with_successors: false });
        if (r.changes?.length) this.record(this.datesStep(r.changes));
        GX.toast(T('rescheduled_n', { n: r.changed }));
      } catch (err) { GX.toast(err.message, true); }
      this.load(true);
    }

    // pasted / typed rows below the last task become new tasks (leading spaces = hierarchy)
    async onCreate(afterRow, objs) {
      if (!this.data.permissions.add_issues) { GX.toast(T('no_permission_add'), true); return; }
      const rows = objs.map((o) => {
        const raw = String(o.subject ?? '');
        const lead = raw.match(/^[ 　]*/)[0].replace(/　/g, '  ');
        const r = { level: lead.length >> 1, subject: raw.trim() };
        if (o.assignee) r.assigned_to = String(o.assignee).trim();
        const s = o.start ? GX.parseDate(o.start, this.today) : null;
        if (s != null) r.start_date = GX.toStr(s);
        const e = o.end ? GX.parseDate(o.end, this.today) : null;
        if (e != null) r.due_date = GX.toStr(e);
        const h = o.est && parseFloat(String(o.est).replace(/[^\d.]/g, ''));
        if (h) r.estimated_hours = h;
        return r;
      }).filter((r) => r.subject);
      if (!rows.length) return;
      const minLevel = Math.min(...rows.map((r) => r.level));
      rows.forEach((r) => { r.level -= minLevel; });
      if (rows.length > 1 && !confirm(T('create_rows_confirm', { n: rows.length }))) return;
      const body = { rows };
      if (afterRow) {
        const at = afterRow.task;
        body.after_id = at.id;
        if (this.byId[at.parent_id]) body.parent_id = at.parent_id;
      }
      try {
        const res = await this.api('POST', '/tasks/import', body);
        if (this.data.trash && res.ids.length) this.record(this.addStep(res.ids));
        GX.toast(T('created_n', { n: res.ids.length }));
      } catch (e) { GX.toast(e.message, true); }
      this.load(true);
    }

    async addTask(child) {
      const row = this.grid.rows[this.grid.sel.r];
      if (child && !row) { GX.toast(T('select_task'), true); return; }
      const body = { subject: T('new_task') };
      if (child) { body.parent_id = row.id; delete this.collapsed[row.id]; }
      else if (row) { if (this.byId[row.task.parent_id]) body.parent_id = row.task.parent_id; body.after_id = row.id; }
      try {
        const res = await this.api('POST', '/tasks', body);
        if (this.data.trash) this.record(this.addStep([res.id]));
        await this.load(true);
        const i = this.rowIndex[res.id];
        if (i != null) { this.grid.select(i, 2); this.grid.startEdit('edit'); this.grid.proxy.select(); }
      } catch (e) { GX.toast(e.message, true); }
    }

    moveSelected(dir) {
      const rows = this.grid.selectedRows();
      if (dir === 'down') rows.reverse();
      const moves = [];
      this.eachSelectedRows(rows, async (r) => moves.push({ id: r.id, ...(await this.api('POST', `/tasks/${r.id}/move`, { direction: dir })) }),
        () => { if (moves.length) this.record(this.placeStep(moves)); });
    }
    // +done+ runs after the rows, also when one failed: what was done can still be undone
    async eachSelectedRows(rows, fn, done) {
      if (!rows.length) { GX.toast(T('select_task'), true); return; }
      try { for (const r of rows) await fn(r); } catch (e) { GX.toast(e.message, true); }
      done?.();
      this.load(true);
    }
    deleteSelected() {
      const rows = this.grid.selectedRows();
      if (!rows.length) { GX.toast(T('select_task'), true); return; }
      const msg = T(this.data.trash ? 'trash_confirm' : 'delete_confirm', { n: rows.length });
      const kids = rows.some((r) => r.hasChildren) ? `\n${T('delete_children')}` : '';
      const hours = rows.some((r) => (r.hasChildren ? r.task.spent_total : r.task.spent_hours) > 0) ? `\n${T('delete_keeps_time')}` : '';
      if (!confirm(`${msg}${kids}${hours}\n${T('are_you_sure')}`)) return;
      // a subtask of a selected task goes with it
      const ids = new Set(rows.map((r) => r.id));
      const under = (t) => { for (let p = this.byId[t.parent_id]; p; p = this.byId[p.parent_id]) if (ids.has(p.id)) return true; return false; };
      const tops = [], trashed = [], times = {};
      this.eachSelectedRows(rows.filter((r) => !under(r.task)), async (r) => {
        const res = await this.api('DELETE', `/tasks/${r.id}`);
        tops.push(r.id);
        trashed.push(...res.ids);
        Object.assign(times, res.time_entries);
      }, () => { if (this.data.trash && tops.length) this.record(this.trashStep(tops, trashed, times)); });
    }

    // ---------------------------------------------------------------- layout
    build() {
      this.toolbar = el('div', { class: 'gx-toolbar' });
      const gridHost = el('div', { class: 'gx-host' });
      this.loadEl = el('div', { class: 'gx-load', hidden: true });
      this.status = el('div', { class: 'gx-status' }, [el('span', { class: 'l' }), el('span', { class: 'r' }), el('span', { class: 'k' })]);
      this.root.append(this.toolbar, gridHost, this.loadEl, this.status);
      // until the first data arrives only the (empty) toolbar takes room, see .gx-loading in gantrix.css
      this.root.classList.add('gx-loading');
      this.timeline = new GX.Timeline({ firstDay: 0, lastDay: -1, zoom: this.zoom, versions: [] });
      this.grid = new GX.Grid(gridHost, {
        rowHeight: RH, headerHeight: 66, newRow: true, timeline: this.timeline,
        rowClass: (row) => [row.late ? 'late' : row.behind ? 'behind' : '', row.hasChildren && 'parent', row.task?.context && 'ctx'].filter(Boolean).join(' '),
        onEdit: (ch) => this.onEdit(ch),
        onCreate: (after, objs) => this.onCreate(after, objs),
        onToggle: (row) => this.toggle(row.task),
        onSelection: (g) => this.renderStatus(g),
        onUndo: () => this.undo(),
        onRedo: () => this.redo(),
        onKey: (e) => this.shortcut(e),
        onContextMenu: (e) => this.contextMenu(e),
        // double-click a bar (or the mark of a task outside the period): open its issue
        onTimelineDblClick: (target) => {
          const bar = target.closest?.('.gx-tl-bar, .gx-tl-out');
          if (bar) this.openIssue(bar.dataset.id);
          return !!bar;
        },
        onRender: () => this.renderLoad(),
      });
      this.grid.scroll.addEventListener('scroll', () => { this.loadEl.scrollLeft = this.grid.scroll.scrollLeft; });
      this.resize = () => {
        const pane = this.loadEl.hidden ? 0 : this.loadEl.offsetHeight + 6;
        this.grid.scroll.style.height = `${Math.max(240, window.innerHeight - gridHost.getBoundingClientRect().top - 46 - pane)}px`;
        if (this.data) this.grid.renderWindow();
      };
      window.addEventListener('resize', this.resize);
      requestAnimationFrame(this.resize);
      document.addEventListener('click', (e) => { if (this.menu && !this.menu.contains(e.target)) this.closeMenu(); });
      // printing from the browser menu: lay out pages with the last used paper
      window.addEventListener('beforeprint', () => { if (!this.printing && this.data) this.print(...this.printSpan(), this.paper, false); });
    }

    // One row: over the table what changes the table (adding, structure, history, the tree, which tasks), over
    // the chart what changes the chart (dates, how it looks, the baseline, rescheduling); the summary is in the
    // status bar. Controls keep their width whatever they show, so nothing moves when a setting changes.
    refreshToolbar() {
      const p = this.data.permissions, tb = this.toolbar;
      tb.replaceChildren();
      const group = (...nodes) => tb.append(el('span', { class: 'gx-group' }, nodes));
      // a button that opens a menu: the arrow at its right end
      const menuBtn = (icon, label, title, open, cls = '') => {
        const b = ibtn(icon, label, title, (e) => { e.stopPropagation(); open(e.currentTarget); }, `gx-dd ${cls}`);
        const caret = GX.icon('chevron-down');
        caret.classList.add('gx-caret');
        b.append(caret);
        return b;
      };
      const add = ibtn('plus', T('add_task'), T('add_task_tip'), () => this.addTask(false), 'primary');
      const addMore = ibtn('chevron-down', null, T('add_more'), (e) => { e.stopPropagation(); this.addMenu(e.currentTarget); }, 'primary');
      add.disabled = addMore.disabled = !p.add_issues;
      tb.append(el('span', { class: 'gx-split' }, [add, addMore]));
      const moves = [['indent-decrease', 'outdent'], ['indent-increase', 'indent'], ['arrow-up', 'up'], ['arrow-down', 'down']].map(([icon, dir]) => {
        const b = ibtn(icon, null, T(`${dir}_tip`), () => this.moveSelected(dir));
        b.disabled = !p.edit;
        return b;
      });
      const del = ibtn('trash', null, T('key_tip', { label: this.data.trash ? T('move_to_trash') : T('delete'), key: T('key_delete_row') }), () => this.deleteSelected());
      del.disabled = !p.delete_issues;
      group(...moves, del);
      this.undoBtn = ibtn('arrow-back-up', null, T('undo_tip'), () => this.undo());
      this.redoBtn = ibtn('arrow-forward-up', null, T('redo_tip'), () => this.redo());
      group(this.undoBtn, this.redoBtn);
      this.refreshUndo();
      group(ibtn('chevrons-down', null, T('expand_all'), () => this.expandAll()), ibtn('chevrons-up', null, T('collapse_all'), () => this.collapseAll()));
      if (this.queryId && this.data.query_id !== this.queryId) { this.queryId = null; this.save(); } // deleted or no longer visible
      const query = (this.data.queries ?? []).find((q) => q.id === this.queryId);
      // the tip starts with the whole name: a long query name is cut short in the button
      const label = query ? query.name : T(this.showClosed ? 'view_all' : 'view_needed');
      const scope = menuBtn('filter', label, `${label}\n\n${T('scope_tip')}`, (a) => this.scopeMenu(a), `gx-scope${query ? ' on' : ''}`);
      group(el('span', { class: 'gx-label', text: T('scope') }), scope);
      tb.append(el('span', { class: 'gx-spacer' }));
      group(ibtn('target', T('today'), T('key_tip', { label: T('go_today'), key: 'Ctrl+G' }), () => this.scrollToDay(this.today - 7)),
            el('span', { class: 'gx-seg' }, ['day', 'week', 'month'].map((z) => btn(T(`zoom_${z}`), null, () => {
              this.zoom = z;
              this.save();
              this.refreshToolbar();
              this.setupTimeline();
              this.grid.render();
              this.scrollToDay(this.today - 7);
            }, this.zoom === z ? 'on' : ''))));
      if (!this.data.baselines.some((b) => b.id === this.baselineId)) this.baselineId = '';
      const res = ibtn('calendar-share', T('reschedule'), T('reschedule_tip'), () => this.openReschedule());
      res.disabled = !p.edit_issues;
      group(menuBtn('adjustments-horizontal', T('view'), T('view_menu_tip'), (a) => this.viewMenu(a)),
            menuBtn('flag', T('baseline'), T('compare_tip'), (a) => this.baselineMenu(a), this.baselineId ? 'on' : ''),
            res, ibtn('dots', null, T('more'), (e) => { e.stopPropagation(); this.moreMenu(e.currentTarget); }));
    }

    // the summary, in the status bar: closed tasks not loaded count too (their totals come from the server)
    renderSummary() {
      const base = this.baseDay;
      const h = this.data.hidden_summary;
      let W = h?.w ?? 0, EV = h?.ev ?? 0, PV = h?.pv ?? 0, late = h?.late ?? 0, behind = h?.behind ?? 0;
      for (const t of this.data.tasks) {
        if (!this.isLeaf(t) || t.s == null || t.e == null) continue;
        W += t.w;
        EV += t.w * t.done_ratio / 100;
        PV += this.cal.elapsed(t.s, t.e, base);
        if (t.done_ratio < 100 && t.e < base) late++;
        else if (t.s <= base && t.done_ratio < Math.floor(this.cal.elapsed(t.s, t.e, base) / t.w * 100)) behind++;
      }
      const pct = (v) => (W ? `${(v / W * 100).toFixed(1)}%` : '-');
      const spi = PV ? EV / PV : null;
      const items = [
        [T('kpi_planned'), pct(PV)], [T('kpi_actual'), pct(EV)],
        ['SPI', spi == null ? '-' : spi.toFixed(2), spi != null && spi < 0.9 ? 'bad' : ''],
        [T('kpi_behind'), T('count_n', { n: behind }), behind ? 'warn' : ''],
        [T('kpi_overdue'), T('count_n', { n: late }), late ? 'bad' : ''],
        [T('kpi_status_date'), GX.fmtDay(base)],
      ];
      const k = this.status.querySelector('.k');
      k.classList.toggle('alert', late > 0 || behind > 0);
      k.innerHTML = items.map(([label, value, cls = '']) => `<span class="gx-kpi ${cls}">${esc(label)} <b>${esc(value)}</b></span>`).join('');
    }

    // ---------------------------------------------------------------- tree
    expandAll() {
      this.collapsed = {};
      // in progress: the tasks not loaded yet come with one request
      if (!this.showClosed && !this.queryId && this.data.tasks.some((t) => t.more)) {
        this.openAll = true;
        this.save();
        this.load(true);
        return;
      }
      this.save();
      this.redraw();
    }
    collapseAll() {
      this.openAll = false;
      this.opened.clear();
      this.collapsed = {};
      for (const t of this.data.tasks) if (t.children.length || t.more) this.collapsed[t.id] = true;
      this.save();
      this.redraw();
    }
    redraw() {
      this.buildRows();
      this.grid.setRows(this.rows);
      this.grid.render();
    }

    renderStatus(g) {
      const rows = this.grid.rows.slice(g.r1, g.r2 + 1);
      let days = 0, est = 0, s = null, e = null;
      for (const row of rows) {
        const t = row.task;
        if (!row.hasChildren) { days += row.days ?? 0; est += +t.estimated_hours || 0; }
        if (t.s != null) s = s == null ? t.s : Math.min(s, t.s);
        if (t.e != null) e = e == null ? t.e : Math.max(e, t.e);
      }
      this.status.querySelector('.l').textContent = `${T('selection_size', { r: g.r2 - g.r1 + 1, c: g.c2 - g.c1 + 1 })}${T('sep')}${T('status_hint')}`;
      this.status.querySelector('.r').textContent = rows.length
        ? [T('sum_days', { n: days }), est ? T('sum_hours', { n: Math.round(est * 10) / 10 }) : null,
           s != null ? T('period', { s: GX.fmtDay(s), e: GX.fmtDay(e) }) : null].filter(Boolean).join(T('sep'))
        : '';
    }

    // ---------------------------------------------------------------- shortcuts & menus
    shortcut(e) {
      const k = e.key, ctrl = e.ctrlKey || e.metaKey, key = k.toLowerCase();
      const dirs = { ArrowRight: 'indent', ArrowLeft: 'outdent', ArrowUp: 'up', ArrowDown: 'down' };
      if (e.altKey && e.shiftKey && dirs[k]) { this.moveSelected(dirs[k]); return true; }
      if (ctrl && k === 'Enter') { this.addTask(true); return true; }
      if (ctrl && (k === '+' || k === ';')) { this.addTask(false); return true; }
      if (ctrl && k === '-') { this.deleteSelected(); return true; }
      if (ctrl && key === 'r') { this.openReschedule(); return true; }
      if (ctrl && key === 'g') { this.scrollToDay(this.today - 7); return true; }
      if (ctrl && key === 'p') { this.openPrint(); return true; }
      return false;
    }

    closeMenu() { this.menu?.remove(); this.menu = null; }
    popup(x, y, items) {
      this.closeMenu();
      const m = el('div', { class: 'gx-menu', role: 'menu' });
      for (const it of items) {
        if (!it) { m.append(el('div', { class: 'sep' })); continue; }
        if (it.head) { m.append(el('div', { class: 'head', text: it.head })); continue; }
        const n = el('div', { class: `item${it.disabled ? ' off' : ''}`, role: 'menuitem' },
          [el('span', { class: 'mark', text: it.checked ? '✓' : '' }), it.icon ? GX.icon(it.icon) : el('span'),
           el('span', { class: 'lab', text: it.label }), el('span', { class: 'key', text: it.key ?? '' })]);
        if (!it.disabled) n.addEventListener('click', (e) => { e.stopPropagation(); if (!it.keep) this.closeMenu(); it.run(n); });
        m.append(n);
      }
      document.body.append(m);
      m.style.left = `${Math.min(x, window.innerWidth - m.offsetWidth - 8)}px`;
      m.style.top = `${Math.min(y, window.innerHeight - m.offsetHeight - 8)}px`;
      this.menu = m;
    }
    contextMenu(e) {
      const g = this.grid, p = this.data.permissions, row = g.rows[g.sel.r];
      this.popup(e.clientX, e.clientY, [
        { icon: 'copy', label: T('copy'), key: 'Ctrl+C', run: () => { g.focus(); document.execCommand('copy'); } },
        { icon: 'cut', label: T('cut'), key: 'Ctrl+X', run: () => { g.focus(); document.execCommand('cut'); } },
        { icon: 'clipboard', label: T('paste'), key: 'Ctrl+V', run: () => GX.toast(T('paste_use_keyboard')) },
        null,
        { icon: 'row-insert-top', label: T('insert_row'), key: T('key_add_row'), disabled: !p.add_issues, run: () => this.addTask(false) },
        { icon: 'subtask', label: T('add_subtask'), key: 'Ctrl+Enter', disabled: !p.add_issues || !row, run: () => this.addTask(true) },
        { icon: 'indent-increase', label: T('indent'), key: 'Alt+Shift+→', disabled: !p.edit, run: () => this.moveSelected('indent') },
        { icon: 'indent-decrease', label: T('outdent'), key: 'Alt+Shift+←', disabled: !p.edit, run: () => this.moveSelected('outdent') },
        null,
        { icon: 'arrow-bar-to-down', label: T('fill_down'), key: 'Ctrl+D', run: () => g.fillDown() },
        { icon: 'eraser', label: T('clear_cells'), key: 'Delete', run: () => g.clearRange() },
        { icon: 'calendar-share', label: T('reschedule'), key: 'Ctrl+R', disabled: !p.edit_issues, run: () => this.openReschedule() },
        { icon: 'external-link', label: T('open_issue'), disabled: !row, run: () => this.openIssue(row.id) },
        null,
        { icon: 'trash', label: this.data.trash ? T('move_to_trash') : T('delete'), key: T('key_delete_row'), disabled: !p.delete_issues || !row, run: () => this.deleteSelected() },
      ]);
    }
    // a toggle that stays open, so several can be changed at once
    toggleItem(label, on, apply, icon) {
      let value = on;
      return { icon, label, checked: on, keep: true, run: (n) => { value = !value; n.querySelector('.mark').textContent = value ? '✓' : ''; apply(value); } };
    }
    below(anchor, items, right = false) {
      const r = anchor.getBoundingClientRect();
      this.popup(right ? r.right - 260 : r.left, r.bottom + 4, items);
    }
    addMenu(anchor) {
      const row = this.grid.rows[this.grid.sel.r];
      this.below(anchor, [
        { icon: 'plus', label: T('add_task_item'), key: 'Ctrl+;', run: () => this.addTask(false) },
        { icon: 'subtask', label: T('add_subtask_item'), key: 'Ctrl+Enter', disabled: !row?.task, run: () => this.addTask(true) },
      ]);
    }
    // which tasks: in progress or all (each starts unfolded its own way), or a saved Redmine query
    scopeMenu(anchor) {
      const queries = this.data.queries ?? [];
      const mode = (all) => () => { this.showClosed = all; this.queryId = null; this.collapsed = {}; this.opened.clear(); this.openAll = false; this.save(); this.load(true); };
      const n = this.data.needed ? this.data.hidden_count : 0;
      const query = (q) => ({ label: q.name, checked: this.queryId === q.id, run: () => { this.queryId = q.id; this.save(); this.load(true); } });
      const marked = queries.filter((q) => q.bookmarked), rest = queries.filter((q) => !q.bookmarked);
      this.below(anchor, [
        { head: T('scope_range') },
        { label: `${T('view_needed')}${n ? T('view_folded', { n: n.toLocaleString() }) : ''}`, checked: !this.queryId && !this.showClosed, run: mode(false) },
        { label: T('view_all'), checked: !this.queryId && this.showClosed, run: mode(true) },
        ...(marked.length ? [null, { head: T('filter_bookmarked') }, ...marked.map(query)] : []),
        ...(rest.length ? [null, { head: T('filter_saved') }, ...rest.map(query)] : []),
        null,
        { icon: 'plus', label: T('filter_new_query'), run: () => { window.location.href = this.cfg.newQueryUrl; } },
      ]);
    }
    viewMenu(anchor) {
      const chart = () => { this.save(); this.setupTimeline(); this.grid.render(); };
      this.below(anchor, [
        { head: T('columns') },
        ...OPTIONAL.map((k) => this.toggleItem(T(OPTIONAL_TITLE[k]), this.extraCols.includes(k), (on) => {
          this.extraCols = on ? [...this.extraCols, k] : this.extraCols.filter((x) => x !== k);
          this.save();
          this.grid.setColumns(this.columns());
          this.grid.render();
        })),
        null,
        this.toggleItem(T('progress_line'), this.inazuma, (on) => { this.inazuma = on; chart(); }, 'bolt'),
        this.toggleItem(T('critical_path'), this.critical, (on) => { this.critical = on; chart(); }, 'route'),
        this.toggleItem(T('load_pane'), this.loadPane, (on) => { this.loadPane = on; this.save(); this.renderLoad(); this.resize(); }, 'chart-bar'),
      ], true);
    }
    baselineMenu(anchor) {
      const p = this.data.permissions;
      const compare = (id) => () => { this.baselineId = id; this.save(); this.load(true); };
      this.below(anchor, [
        { label: T('compare_none'), checked: !this.baselineId, run: compare('') },
        ...this.data.baselines.map((b) => ({ label: T('compare_with', { name: b.name }), checked: this.baselineId === b.id, run: compare(b.id) })),
        null,
        { icon: 'flag', label: `${T('save_baseline')}…`, disabled: !p.edit, run: () => this.saveBaseline() },
        { icon: 'trash', label: T('delete_baseline'), disabled: !this.baselineId || !p.edit, run: () => this.deleteBaseline() },
      ], true);
    }
    // ---------------------------------------------------------------- print
    printSpan() {
      const ds = this.rows.flatMap((r) => [r.task.s, r.task.e]).filter((d) => d != null);
      return ds.length ? [Math.min(...ds), Math.max(...ds)] : [this.today, this.today + 30];
    }
    openPrint() {
      const [lo, hi] = this.printSpan();
      const from = el('input', { type: 'date', class: 'gx-input', value: GX.toStr(lo) });
      const to = el('input', { type: 'date', class: 'gx-input', value: GX.toStr(hi) });
      const paper = el('select', { class: 'gx-input' }, Object.keys(PAPERS).map((k) => el('option', { value: k, text: T(`paper_${k}`) })));
      paper.value = this.paper ?? 'a3';
      this.dialog(T('print'), [
        el('label', {}, [T('print_from'), from]),
        el('label', {}, [T('print_to'), to]),
        el('label', {}, [T('print_paper'), paper]),
        el('div', { class: 'gx-dialog-note', text: T('print_note') }),
      ], T('print_ok'), () => {
        const a = GX.toDay(from.value), b = GX.toDay(to.value);
        if (a == null || b == null || b < a) { GX.toast(T('print_bad_range'), true); return false; }
        this.paper = paper.value;
        setTimeout(() => this.print(a, b, paper.value), 0); // once the dialog is gone
        return true;
      });
    }
    // lays the schedule out on pages (the period fitted to the paper width), prints, then restores the screen
    print(from, to, paper = 'a3', andPrint = true) {
      if (this.printing) return;
      this.printing = true;
      const P = PAPERS[paper] ?? PAPERS.a3, MM = 96 / 25.4, TITLE = 40;
      const days = to - from + 1, fz = this.grid.fzW, pageW = P.w * MM, pageH = P.h * MM;
      let dw = (pageW - fz) / days, scale = 1;
      if (dw < 3) { dw = 3; scale = pageW / (fz + dw * days); } // long periods: shrink the whole page instead
      const ctx = this.timeline.ctx, keep = { firstDay: ctx.firstDay, lastDay: ctx.lastDay, zoom: ctx.zoom };
      Object.assign(ctx, { firstDay: from, lastDay: to, zoom: dw >= 16 ? 'day' : dw >= 5 ? 'week' : 'month', dayWidth: dw });
      this.grid.renderHead();
      const perPage = Math.max(1, Math.floor((pageH / scale - TITLE - this.grid.HH) / RH));
      const pages = this.grid.printPages(perPage);
      const query = (this.data.queries ?? []).find((q) => q.id === this.data.query_id);
      const kpis = [...this.status.querySelectorAll('.gx-kpi')].map((n) => n.outerHTML).join('');
      const title = (i) => `<div class="gx-ptitle"><b>${esc(this.cfg.projectName)}</b>${query ? `<span>${esc(T('filter'))}: ${esc(query.name)}</span>` : ''}${kpis}`
        + `<span class="r">${esc(T('print_period', { s: GX.fmtDay(from), e: GX.fmtDay(to) }))}${T('gap')}${esc(T('print_page', { i, n: pages.length }))}</span></div>`;
      const sheet = el('div', { class: 'gx-print', style: `zoom:${scale}`, html: pages.map((p, i) => `<section class="gx-sheet">${title(i + 1)}${p}</section>`).join('') });
      const style = el('style', { text: `@page { size: ${P.size} landscape; margin: 10mm; }` });
      document.head.append(style);
      this.root.append(sheet);
      document.body.classList.add('gx-printing');
      window.addEventListener('afterprint', () => {
        sheet.remove();
        style.remove();
        document.body.classList.remove('gx-printing');
        Object.assign(ctx, keep);
        delete ctx.dayWidth;
        this.grid.render();
        this.printing = false;
      }, { once: true });
      if (andPrint) window.print();
    }

    moreMenu(anchor) {
      this.below(anchor, [
        { icon: 'file-spreadsheet', label: T('save_csv'), run: () => this.exportCsv() },
        { icon: 'printer', label: `${T('print')}…`, key: 'Ctrl+P', run: () => this.openPrint() },
      ], true);
    }

    // ---------------------------------------------------------------- dialogs
    dialog(title, body, okLabel, onOk, onClose) {
      const overlay = el('div', { class: 'gx-modal' });
      const close = () => { overlay.remove(); onClose?.(); };
      const ok = el('button', { type: 'button', class: 'gx-btn primary', text: okLabel, onclick: () => { if (onOk() !== false) close(); } });
      overlay.append(el('div', { class: 'gx-dialog', role: 'dialog', 'aria-label': title }, [
        el('h3', { text: title }), ...body,
        el('div', { class: 'gx-dialog-btns' }, [el('button', { type: 'button', class: 'gx-btn', text: T('cancel'), onclick: close }), ok]),
      ]));
      overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
      overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
      document.body.append(overlay);
    }
    // the issue page in a new tab, so the schedule keeps its scroll position and selection
    issueUrl(id) { return `${this.cfg.issuesUrl}/${id}`; }
    openIssue(id) { window.open(this.issueUrl(id), '_blank', 'noopener'); }
    // a link inside a grid cell: the grid leaves clicks on links alone (no cell selection)
    openLink(id, text) {
      const tip = esc(T('open_issue_tip', { id }));
      return text == null
        ? `<a class="gx-open" href="${esc(this.issueUrl(id))}" target="_blank" rel="noopener" title="${tip}" aria-label="${tip}">${GX.iconHtml('external-link')}</a>`
        : `<a class="gx-idlink" href="${esc(this.issueUrl(id))}" target="_blank" rel="noopener" title="${tip}">${esc(text)}</a>`;
    }

    openReschedule() {
      const rows = this.grid.selectedRows();
      if (!rows.length) { GX.toast(T('select_task'), true); return; }
      const days = el('input', { type: 'number', value: '1', class: 'gx-input', style: 'width:80px' });
      const succ = el('input', { type: 'checkbox', checked: true });
      const notes = el('textarea', { rows: 3, class: 'gx-input', placeholder: T('reschedule_reason_ph') });
      const list = el('ul', { class: 'gx-dialog-list' }, rows.map((r) => el('li', { text: T('paren', { text: `${r.wbs} ${r.task.subject}`, note: GX.range(GX.fmtDay(r.task.s), GX.fmtDay(r.task.e)) }) })));
      const preview = el('div', { class: 'gx-preview' });
      const body = () => ({ issue_ids: rows.map((r) => r.id), days: parseInt(days.value, 10), with_successors: succ.checked });
      // the result before saving: moved tasks in the dialog, their new positions as ghost bars
      let timer = null, seq = 0;
      const showPreview = () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          const b = body(), my = ++seq;
          if (!b.days) { preview.replaceChildren(); this.setPreview(null); return; }
          try {
            const r = await GX.api(this.cfg.baseUrl, 'POST', '/reschedule/preview', b);
            if (my !== seq) return;
            this.renderPreview(preview, r);
            this.setPreview(new Map(r.changes.map((c) => [c.id, [GX.toDay(c.to[0]), GX.toDay(c.to[1])]])));
          } catch (e) {
            if (my === seq) preview.replaceChildren(el('div', { class: 'gx-dialog-note err', text: e.message }));
          }
        }, 250);
      };
      days.addEventListener('input', showPreview);
      succ.addEventListener('change', showPreview);
      this.dialog(T('reschedule_title'), [
        el('div', { class: 'gx-dialog-label', text: T('reschedule_targets') }), list,
        el('label', { class: 'row' }, [T('reschedule_days'), ' ', days, ' ', T('reschedule_days_suffix')]),
        el('label', { class: 'row' }, [succ, ' ', T('reschedule_with_successors')]),
        preview,
        el('label', {}, [T('reschedule_reason'), notes]),
      ], T('reschedule_run'), () => {
        const b = body();
        if (!b.days) { GX.toast(T('days_invalid'), true); return false; }
        this.api('POST', '/reschedule', { ...b, notes: notes.value })
          .then((r) => { if (r.changes?.length) this.record(this.datesStep(r.changes)); GX.toast(T('rescheduled_n', { n: r.changed })); })
          .catch((e) => GX.toast(e.message, true))
          .finally(() => this.load(true));
        return true;
      }, () => { clearTimeout(timer); seq++; this.setPreview(null); });
      showPreview();
      requestAnimationFrame(() => { days.focus(); days.select(); });
    }
    setPreview(map) {
      this.preview = map;
      this.timeline.ctx.preview = map;
      this.grid.refresh();
    }
    renderPreview(box, r) {
      const n = r.changes.length;
      const from = GX.toDay(r.finish.from), to = GX.toDay(r.finish.to);
      const year = GX.dt(this.today).getUTCFullYear();
      const shift = from != null && to != null ? (to >= from ? this.cal.workingDays(from, to) - 1 : -(this.cal.workingDays(to, from) - 1)) : 0;
      const items = r.changes.slice(0, 8).map((c) => {
        const t = this.byId[c.id];
        const task = `${this.wbsById[c.id] ?? ''} ${t?.subject ?? `#${c.id}`}`.trim();
        return el('li', { text: T('change_line', { task, from: GX.fmtDay(GX.toDay(c.from[1]), year), to: GX.fmtDay(GX.toDay(c.to[1]), year) }) });
      });
      if (n > 8) items.push(el('li', { text: T('and_more_n', { n: n - 8 }) }));
      box.replaceChildren(
        el('div', { class: 'gx-dialog-label', text: T('preview_title', { n }) }),
        el('div', { class: `gx-preview-finish${shift > 0 ? ' late' : ''}`, text: T('preview_finish', { from: GX.fmtDay(from, year), to: GX.fmtDay(to, year), d: `${shift > 0 ? '+' : ''}${shift}` }) }),
        el('ul', { class: 'gx-dialog-list' }, items),
      );
    }

    // ---------------------------------------------------------------- workload pane
    // estimated hours of open leaf tasks, spread evenly over their working days, per assignee,
    // in the same columns as the chart (days, weeks or months)
    renderLoad() {
      const pane = this.loadEl, show = this.loadPane && !!this.data;
      if (pane.hidden === show) { pane.hidden = !show; requestAnimationFrame(() => this.resize?.()); }
      if (!show) return;
      const ctx = this.timeline.ctx, tl = this.timeline, cal = this.cal, hpd = this.data.hours_per_day || 8;
      const first = ctx.firstDay, last = ctx.lastDay, n = last - first + 1;
      const people = new Map(); // assignee id -> { name, hours: Float64Array }
      for (const t of this.data.tasks) {
        if (!this.isLeaf(t) || t.closed || !t.assigned_to_id || !(+t.estimated_hours > 0) || t.s == null || t.e == null) continue;
        const wd = cal.workingDays(t.s, t.e), per = +t.estimated_hours / wd;
        if (!people.has(t.assigned_to_id)) people.set(t.assigned_to_id, { name: t.assigned_to, hours: new Float64Array(n) });
        const h = people.get(t.assigned_to_id).hours;
        for (let d = Math.max(t.s, first); d <= Math.min(t.e, last); d++) if (cal.isWorking(d)) h[d - first] += per;
      }
      // columns: days, Monday-start weeks or calendar months
      const buckets = [];
      for (let d = first; d <= last;) {
        let e = d;
        if (ctx.zoom === 'week') e = Math.min(last, d + 6 - ((GX.wday(d) + 6) % 7));
        else if (ctx.zoom === 'month') { const x = GX.dt(d); e = Math.min(last, GX.toDay(new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).toISOString())); }
        buckets.push([d, e, cal.workingDays(d, e) * (cal.isWorking(d) || d !== e ? 1 : 0)]);
        d = e + 1;
      }
      const order = this.data.users.map((u) => u.id);
      const ids = [...people.keys()].sort((a, b) => ((order.indexOf(a) + 1) || 1e9) - ((order.indexOf(b) + 1) || 1e9));
      const fz = this.grid.fzW, W = fz + tl.width(), rows = [];
      for (const id of ids) {
        const p = people.get(id);
        let peak = 0;
        const cells = buckets.map(([s, e, wd]) => {
          let h = 0;
          for (let d = s; d <= e; d++) h += p.hours[d - first];
          if (h < 0.05 || !wd) return '';
          const cap = wd * hpd, ratio = h / cap, w = (e - s + 1) * tl.dw;
          peak = Math.max(peak, ratio);
          const level = ratio > 1 ? 'over' : ratio > 0.8 ? 'full' : 'ok';
          const label = w >= 16 ? (Math.round(h * 10) / 10).toString() : '';
          const tip = `${p.name} ${e !== s ? GX.range(GX.fmtDay(s), GX.fmtDay(e)) : GX.fmtDay(s)}: ${T('load_tip', { h: Math.round(h * 10) / 10, cap, p: Math.round(ratio * 100) })}`;
          return `<div class="gx-lc ${level}" style="left:${tl.x(s)}px;width:${w}px;--load:${Math.min(ratio, 1).toFixed(2)}" title="${esc(tip)}">${label}</div>`;
        }).join('');
        const badge = peak > 1 ? `<span class="gx-lover">${esc(T('load_peak', { p: Math.round(peak * 100) }))}</span>` : '';
        rows.push(`<div class="gx-lr"><div class="gx-lname" style="width:${fz}px">${esc(p.name)}${badge}</div><div class="gx-lcells" style="left:${fz}px">${cells}</div></div>`);
      }
      const head = `<div class="gx-lr gx-lhead"><div class="gx-lname" style="width:${fz}px">${esc(T('load_title', { h: hpd }))}</div></div>`;
      pane.innerHTML = `<div class="gx-lcanvas" style="width:${W}px">${head}${rows.join('') || `<div class="gx-lr"><div class="gx-lname gx-lnone" style="width:${fz}px">${esc(T('load_none'))}</div></div>`}</div>`;
      pane.scrollLeft = this.grid.scroll.scrollLeft;
    }

    // ---------------------------------------------------------------- dependencies
    addLink(from, to) {
      const t = this.byId[to];
      if (!t || t.preds.includes(from)) { GX.toast(T('link_exists'), true); return; }
      const before = t.preds.join(',');
      this.send([{ id: to, predecessors: [...t.preds, from].join(',') }], [{ id: to, predecessors: before }],
        T('link_added', { a: this.wbsById[from], b: this.wbsById[to] }));
    }
    depMenu(rel, e) {
      const t = this.byId[rel.to];
      if (!t) return;
      const label = T('link_delete', { a: this.wbsById[rel.from], b: this.wbsById[rel.to] });
      this.popup(e.clientX, e.clientY + 4, [{ label, run: () => {
        const before = t.preds.join(',');
        this.send([{ id: rel.to, predecessors: t.preds.filter((x) => x !== rel.from).join(',') }], [{ id: rel.to, predecessors: before }], T('link_deleted'));
      } }]);
    }
    saveBaseline() {
      const name = el('input', { type: 'text', class: 'gx-input', value: T('baseline_default', { date: GX.toStr(this.today) }) });
      const at = el('input', { type: 'datetime-local', class: 'gx-input' });
      this.dialog(T('save_baseline'), [
        el('label', {}, [T('baseline_name'), name]),
        el('label', {}, [T('baseline_at'), at]),
        el('div', { class: 'gx-dialog-note', text: T('baseline_at_note') }),
      ], T('save'), () => {
        this.api('POST', '/baselines', { name: name.value, at: at.value || null })
          .then((r) => { this.baselineId = r.id; this.save(); GX.toast(T('baseline_saved')); })
          .catch((e) => GX.toast(e.message, true))
          .finally(() => this.load(true));
        return true;
      });
      requestAnimationFrame(() => { name.focus(); name.select(); });
    }
    async deleteBaseline() {
      if (!this.baselineId || !confirm(T('baseline_delete_confirm'))) return;
      try {
        await this.api('DELETE', `/baselines/${encodeURIComponent(this.baselineId)}`);
        this.baselineId = '';
        this.save();
        GX.toast(T('baseline_deleted'));
      } catch (e) { GX.toast(e.message, true); }
      this.load(true);
    }

    exportCsv() {
      const cols = this.columns().filter((c) => c.key !== 'rownum');
      const saved = this.collapsed;
      this.collapsed = {};
      this.buildRows();
      const out = [cols.map((c) => c.title), ...this.rows.map((row) => cols.map((c) => {
        if (c.key === 'subject') return '  '.repeat(row.level) + row.task.subject;
        return c.copyText ? c.copyText(row) : c.text(row);
      }))];
      this.collapsed = saved;
      this.buildRows();
      const csv = out.map((r) => r.map((v) => {
        const s = String(v ?? '');
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(',')).join('\r\n');
      const a = el('a', { href: URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv' })), download: `schedule_${this.cfg.project}_${GX.toStr(this.today)}.csv` });
      document.body.append(a);
      a.click();
      a.remove();
    }
  }

  const start = () => {
    const root = document.getElementById('gantrix-schedule');
    if (root && !root.app) root.app = new App(root);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  GX.App = App;
})();
