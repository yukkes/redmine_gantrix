/* 工程表 (Schedule) for Redmine (MIT License)
 * grid: Excel-like table with a timeline area in the same rows.
 *  - only visible rows are rendered (virtual scrolling); grid columns are frozen (sticky)
 *  - one hidden textarea keeps the focus over the active cell, so typing (including IME
 *    composition) starts editing in place; Enter while composing never commits
 *  - range selection, keyboard navigation, copy / cut / paste (TSV), fill handle, Ctrl+D */
(() => {
  'use strict';
  const GX = window.Gantrix;
  const { T, esc, el } = GX;
  const MOVES = { up: [-1, 0], down: [1, 0], left: [0, -1], right: [0, 1] };
  const ARROWS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

  class Grid {
    constructor(host, opts) {
      this.o = opts;
      this.RH = opts.rowHeight ?? 28;
      this.HH = opts.headerHeight ?? 66;
      this.cols = [];
      this.rows = [];
      this.sel = { r: 0, c: 1, ar: 0, ac: 1 };
      this.edit = null;
      this.errs = {};
      this.win = { first: -1, last: -1 };
      this.build(host);
    }

    // ---------------------------------------------------------------- DOM
    build(host) {
      this.root = el('div', { class: 'sg' });
      this.scroll = el('div', { class: 'gx-scroll' });
      this.canvas = el('div', { class: 'gx-canvas' });
      this.head = el('div', { class: 'gx-head' });
      this.body = el('div', { class: 'gx-body' });
      this.bg = el('div', { class: 'gx-bg' });
      this.rowsEl = el('div', { class: 'gx-rows' });
      this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      this.svg.setAttribute('class', 'gx-overlay');
      // shown once it has its size: an element that grows from nothing counts as a layout shift (CLS)
      this.svg.style.display = 'none';
      this.body.append(this.bg, this.rowsEl, this.svg);
      this.canvas.append(this.head, this.body);
      this.scroll.append(this.canvas);
      this.proxy = el('textarea', { class: 'gx-proxy', rows: 1, spellcheck: 'false', autocomplete: 'off', 'aria-label': 'cell editor', style: 'left:-9999px' });
      this.list = el('div', { class: 'gx-list', role: 'listbox' });
      this.picker = el('input', { type: 'date', class: 'gx-picker', tabindex: '-1', 'aria-label': GX.T('pick_date') });
      this.tip = el('div', { class: 'gx-tip' });
      this.root.append(this.scroll, this.proxy, this.list, this.picker, this.tip);
      host.append(this.root);

      this.scroll.addEventListener('scroll', () => {
        if (this.raf) return;
        this.raf = requestAnimationFrame(() => { this.raf = null; this.renderWindow(); this.placeProxy(); });
      });
      this.rowsEl.addEventListener('mousedown', (e) => this.onMouseDown(e));
      this.rowsEl.addEventListener('dblclick', (e) => {
        const hit = this.hit(e.target);
        if (e.target.closest('a[href]')) return;
        if (hit?.c >= 0) { this.select(hit.r, hit.c); this.startEdit('edit'); }
      });
      this.rowsEl.addEventListener('contextmenu', (e) => {
        const hit = this.hit(e.target);
        if (!hit) return;
        if (!this.inRange(hit.r, hit.c)) this.select(hit.r, hit.c >= 0 ? hit.c : this.sel.c);
        if (this.o.onContextMenu) { e.preventDefault(); this.o.onContextMenu(e, this.range()); }
      });
      this.rowsEl.addEventListener('mousemove', (e) => {
        const c = e.target.closest?.('.gx-c.err');
        if (c) this.showTip(c, c.dataset.err); else if (!this.edit) this.hideTip();
      });

      const p = this.proxy;
      p.addEventListener('keydown', (e) => this.onKey(e));
      p.addEventListener('compositionstart', () => { this.composing = true; if (!this.edit) this.startEdit('enter', ''); });
      p.addEventListener('compositionend', () => { this.composing = false; this.updateList(); });
      p.addEventListener('input', () => {
        if (!this.edit && p.value) this.startEdit('enter', null);
        if (!this.edit) p.value = '';
        this.updateList();
        this.autosize();
      });
      p.addEventListener('copy', (e) => { if (!this.edit) this.copy(e, false); });
      p.addEventListener('cut', (e) => { if (!this.edit) this.copy(e, true); });
      p.addEventListener('paste', (e) => { if (!this.edit) this.paste(e); });
      p.addEventListener('blur', () => setTimeout(() => {
        this.composing = false;
        const a = document.activeElement;
        if (this.edit && a !== p && a !== this.picker && !this.list.contains(a)) this.commit(null);
      }, 0));
      this.picker.addEventListener('change', () => {
        if (!this.edit || !this.picker.value) return;
        p.value = this.picker.value.replaceAll('-', '/');
        this.commit('down');
      });
      this.list.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const it = e.target.closest('.gx-li');
        if (!it) return;
        p.value = it.dataset.label;
        this.commit('down');
      });
    }

    // ---------------------------------------------------------------- data
    setColumns(cols) {
      this.cols = cols;
      this.fzW = cols.reduce((a, c) => a + c.width, 0);
      this.renderHead();
      this.dirty = true;
    }
    setRows(rows) {
      this.rows = rows;
      this.errs = {};
      this.clampSel();
      this.dirty = true;
    }
    count() { return this.rows.length + (this.o.newRow ? 1 : 0); }
    isNewRow(r) { return !!this.o.newRow && r === this.rows.length; }
    textOf(col, row) { return col.editText ? col.editText(row) : col.text(row); }

    // ---------------------------------------------------------------- rendering
    renderHead() {
      const tl = this.o.timeline, H = this.HH, groups = [];
      let x = 0;
      for (const c of this.cols) {
        const last = groups.at(-1);
        if (c.group && last?.g === c.group) last.w += c.width;
        else if (c.group) groups.push({ g: c.group, x, w: c.width });
        x += c.width;
      }
      let html = `<div class="gx-hfz" style="width:${this.fzW}px;height:${H}px">`;
      html += groups.map((g) => `<div class="gx-hg" style="left:${g.x}px;width:${g.w}px">${esc(g.g)}</div>`).join('');
      x = 0;
      this.cols.forEach((c, i) => {
        html += `<div class="gx-hc${c.group ? '' : ' tall'}" data-c="${i}" style="left:${x}px;width:${c.width}px">${esc(c.title)}</div>`;
        x += c.width;
      });
      if (tl?.laneLabel) html += `<div class="gx-hlane" style="width:${this.fzW}px">${esc(tl.laneLabel)}</div>`;
      html += '</div>';
      if (tl) html += `<div class="gx-htl" style="left:${this.fzW}px;width:${tl.width()}px;height:${H}px">${tl.headerHTML(H)}</div>`;
      this.head.innerHTML = html;
      this.head.style.height = `${H}px`;
    }

    render() {
      const tl = this.o.timeline;
      const W = this.fzW + (tl ? tl.width() : 0), H = this.count() * this.RH;
      // the body is absolute: without a height the canvas ends below the header, and the sticky header
      // scrolls away with it
      Object.assign(this.canvas.style, { width: `${W}px`, height: `${this.HH + H}px` });
      Object.assign(this.body.style, { height: `${H}px`, top: `${this.HH}px` });
      this.rowsEl.style.width = `${W}px`;
      if (tl) {
        this.renderHead();
        this.bg.style.left = `${this.fzW}px`;
        this.bg.innerHTML = tl.bgHTML(H);
        this.svg.setAttribute('width', tl.width());
        this.svg.setAttribute('height', H);
        this.svg.style.left = `${this.fzW}px`;
        this.svg.style.display = '';
      }
      this.dirty = true;
      this.renderWindow();
      this.placeProxy();
      this.o.onRender?.();
    }

    renderWindow() {
      const n = this.count(), top = Math.max(0, this.scroll.scrollTop - this.HH);
      const first = Math.max(0, Math.floor(top / this.RH) - 12);
      const last = Math.min(n, first + Math.ceil(this.scroll.clientHeight / this.RH) + 24);
      if (!this.dirty && first === this.win.first && last === this.win.last) return;
      this.dirty = false;
      this.win = { first, last };
      const html = [];
      for (let r = first; r < last; r++) html.push(this.rowHTML(r));
      this.rowsEl.innerHTML = html.join('');
      this.o.timeline?.overlay?.(this.svg, first, last);
    }

    rowHTML(r) {
      const row = this.rows[r], isNew = this.isNewRow(r), g = this.range();
      const rowSel = r >= g.r1 && r <= g.r2;
      const cls = ['gx-r', isNew && 'gx-new', row && this.o.rowClass?.(row), rowSel && 'sel'].filter(Boolean).join(' ');
      let h = `<div class="${cls}" data-r="${r}" style="top:${r * this.RH}px;height:${this.RH}px"><div class="gx-fz" style="width:${this.fzW}px">`;
      this.cols.forEach((c, ci) => {
        const inR = rowSel && ci >= g.c1 && ci <= g.c2;
        const err = this.errs[`${r}:${ci}`];
        const cc = ['gx-c', c.align && `a-${c.align}`, inR && 'in', r === this.sel.r && ci === this.sel.c && 'act', err && 'err',
          row && c.cls?.(row), row && c.editable && !c.editable(row) && 'ro'].filter(Boolean).join(' ');
        let content;
        if (isNew) content = c.key === 'subject' ? `<span class="gx-ph">${esc(T('new_row_hint'))}</span>` : '';
        else content = c.html ? c.html(row, r) : esc(c.text(row, r));
        if (inR && r === g.r2 && ci === g.c2 && !this.edit) content += `<i class="gx-fill" title="${esc(T('fill_down'))}"></i>`;
        h += `<div class="${cc}" data-c="${ci}" style="width:${c.width}px"${err ? ` data-err="${esc(err)}"` : ''}>${content}</div>`;
      });
      h += '</div>';
      if (this.o.timeline && row) h += `<div class="gx-tl" style="left:${this.fzW}px;width:${this.o.timeline.width()}px">${this.o.timeline.rowHTML(row, r)}</div>`;
      return `${h}</div>`;
    }

    refresh() { this.dirty = true; this.renderWindow(); this.placeProxy(); }

    // pages for printing: each page repeats the header and shows whole rows only, with its
    // slice of the background and overlay (the same HTML as on screen, shifted up)
    printPages(perPage) {
      const n = this.rows.length, tl = this.o.timeline, W = this.fzW + (tl ? tl.width() : 0), H = n * this.RH;
      const sel = this.sel;
      this.sel = { r: -1, c: -1, ar: -1, ac: -1 }; // no selection on paper
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      const pages = [];
      for (let first = 0; first < n; first += perPage) {
        const last = Math.min(n, first + perPage), rows = [];
        for (let r = first; r < last; r++) rows.push(this.rowHTML(r));
        let layers = `<div class="gx-rows" style="width:${W}px">${rows.join('')}</div>`;
        if (tl) {
          tl.overlay(svg, first, last, true);
          layers = `<div class="gx-bg" style="left:${this.fzW}px">${tl.bgHTML(H)}</div>${layers}`
            + `<svg class="gx-overlay" width="${tl.width()}" height="${H}" style="left:${this.fzW}px">${svg.innerHTML}</svg>`;
        }
        pages.push(`<div class="gx-page" style="width:${W}px"><div class="gx-head" style="height:${this.HH}px">${this.head.innerHTML}</div>`
          + `<div class="gx-pbody" style="height:${(last - first) * this.RH}px"><div class="gx-body" style="top:${-first * this.RH}px;height:${H}px;width:${W}px">${layers}</div></div></div>`);
      }
      this.sel = sel;
      return pages;
    }

    // ---------------------------------------------------------------- selection
    firstCol() { return Math.max(0, this.cols.findIndex((c) => !c.header)); }
    clampSel() {
      const n = this.count() - 1, m = this.cols.length - 1, f = this.firstCol(), s = this.sel;
      const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
      s.r = clamp(s.r, 0, n); s.ar = clamp(s.ar, 0, n);
      s.c = clamp(s.c, f, m); s.ac = clamp(s.ac, f, m);
    }
    range() {
      const { r, c, ar, ac } = this.sel;
      return { r1: Math.min(r, ar), r2: Math.max(r, ar), c1: Math.min(c, ac), c2: Math.max(c, ac) };
    }
    inRange(r, c) { const g = this.range(); return r >= g.r1 && r <= g.r2 && c >= g.c1 && c <= g.c2; }
    select(r, c, extend = false) {
      Object.assign(this.sel, { r, c });
      if (!extend) Object.assign(this.sel, { ar: r, ac: c });
      this.clampSel();
      this.ensureVisible();
      this.refresh();
      this.focus();
      this.o.onSelection?.(this.range());
    }
    selectedRows() {
      const g = this.range();
      return this.rows.slice(g.r1, g.r2 + 1);
    }
    move(dr, dc, extend = false) {
      const r = Math.max(0, Math.min(this.sel.r + dr, this.count() - 1));
      const c = Math.max(this.firstCol(), Math.min(this.sel.c + dc, this.cols.length - 1));
      this.select(r, c, extend);
    }
    ensureVisible() {
      const s = this.scroll, top = this.sel.r * this.RH;
      if (top < s.scrollTop) s.scrollTop = top;
      else if (top + this.HH + this.RH > s.scrollTop + s.clientHeight - 16) s.scrollTop = top + this.HH + this.RH - s.clientHeight + 16;
    }
    focus() { this.proxy.focus({ preventScroll: true }); }
    cellEl(r, c) { return this.rowsEl.querySelector(`.gx-r[data-r="${r}"] .gx-c[data-c="${c}"]`); }
    hit(t) {
      const rowEl = t.closest?.('.gx-r');
      if (!rowEl) return null;
      const cEl = t.closest('.gx-c');
      return { r: +rowEl.dataset.r, c: cEl ? +cEl.dataset.c : -1, timeline: !!t.closest('.gx-tl') };
    }

    // the focus proxy sits over the active cell (invisible until editing) so the IME window opens there
    placeProxy() {
      const cell = this.cellEl(this.sel.r, this.sel.c), p = this.proxy;
      if (!cell) { p.style.left = '-9999px'; return; }
      // positioned inside the root's border: without clientLeft / clientTop it sits 1px right and down
      const rr = this.root.getBoundingClientRect(), cr = cell.getBoundingClientRect();
      const left = cr.left - rr.left - this.root.clientLeft, top = cr.top - rr.top - this.root.clientTop;
      Object.assign(p.style, { left: `${left}px`, top: `${top}px`, height: `${cr.height}px`, minWidth: `${cr.width}px` });
      if (!this.edit) p.style.width = `${cr.width}px`;
      this.placeList();
    }

    onMouseDown(e) {
      const hit = this.hit(e.target);
      if (!hit || e.button !== 0) return;
      // links in cells (open the issue) work as links: no selection, which would redraw them mid-click
      if (e.target.closest('a[href]')) return;
      if (e.target.closest('.gx-tog')) { e.preventDefault(); this.o.onToggle?.(this.rows[hit.r]); return; }
      if (hit.timeline) {
        if (this.edit) this.commit(null);
        // a double-click on the chart: counted on mousedown, because selecting redraws the rows and the
        // browser then sends no dblclick
        if (e.detail === 2) {
          const target = document.elementFromPoint(e.clientX, e.clientY) ?? e.target;
          if (this.o.onTimelineDblClick?.(target, this.rows[hit.r])) { e.preventDefault(); return; }
        }
        // select first: it redraws the rows, so the drag must start on the new elements
        this.select(hit.r, this.sel.c);
        const target = document.elementFromPoint(e.clientX, e.clientY) ?? e.target;
        this.o.timeline?.onMouseDown?.(e, this.rows[hit.r], hit.r, target);
        return;
      }
      e.preventDefault();
      if (hit.c < 0 || this.cols[hit.c]?.header) {
        this.select(hit.r, this.firstCol());
        this.sel.ac = this.cols.length - 1;
        this.refresh();
        return;
      }
      if (this.edit && this.commit(null) === false) return;
      if (e.target.classList.contains('gx-fill')) { this.startFill(e); return; }
      this.select(hit.r, hit.c, e.shiftKey);
      const mv = (ev) => {
        const h = this.hit(document.elementFromPoint(ev.clientX, ev.clientY) ?? document.body);
        if (h && h.c >= 0 && (h.r !== this.sel.r || h.c !== this.sel.c)) {
          Object.assign(this.sel, { r: h.r, c: h.c });
          this.clampSel();
          this.refresh();
          this.o.onSelection?.(this.range());
        }
      };
      const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
    }

    // ---------------------------------------------------------------- keyboard
    onKey(e) {
      if (this.edit) { this.onEditKey(e); return; }
      if (e.isComposing || e.keyCode === 229 || e.key === 'Process') { this.startEdit('enter', ''); return; }
      if (this.o.onKey?.(e, this.range())) { e.preventDefault(); return; }
      const k = e.key, ctrl = e.ctrlKey || e.metaKey, shift = e.shiftKey;
      const page = Math.max(1, Math.floor(this.scroll.clientHeight / this.RH) - 2);
      const nav = {
        ArrowUp: () => this.move(ctrl ? -this.sel.r : -1, 0, shift),
        ArrowDown: () => this.move(ctrl ? this.count() : 1, 0, shift),
        ArrowLeft: () => this.move(0, ctrl ? -99 : -1, shift),
        ArrowRight: () => this.move(0, ctrl ? 99 : 1, shift),
        PageUp: () => this.move(-page, 0, shift),
        PageDown: () => this.move(page, 0, shift),
        Home: () => (ctrl ? this.select(0, this.firstCol()) : this.move(0, -99, shift)),
        End: () => (ctrl ? this.select(this.count() - 1, this.cols.length - 1) : this.move(0, 99, shift)),
        Tab: () => this.move(0, shift ? -1 : 1),
        Enter: () => this.move(shift ? -1 : 1, 0),
        F2: () => this.startEdit('edit'),
        Delete: () => this.clearRange(),
        Backspace: () => this.startEdit('enter', ''),
        Escape: () => { Object.assign(this.sel, { ar: this.sel.r, ac: this.sel.c }); this.refresh(); },
      };
      if (nav[k] && !(ctrl && (k === 'Tab' || k === 'Enter'))) { e.preventDefault(); nav[k](); return; }
      const key = k.toLowerCase();
      if (ctrl && key === 'a') {
        e.preventDefault();
        Object.assign(this.sel, { ar: 0, ac: this.firstCol(), r: this.rows.length - 1, c: this.cols.length - 1 });
        this.refresh();
      } else if (ctrl && key === 'd') { e.preventDefault(); this.fillDown(); }
      else if (ctrl && key === 'z' && !shift) { e.preventDefault(); this.o.onUndo?.(); }
      else if (ctrl && (key === 'y' || (key === 'z' && shift))) { e.preventDefault(); this.o.onRedo?.(); }
      else if (k.length === 1 && !ctrl && !e.altKey) this.startEdit('enter', ''); // the typed character goes into the editor
    }

    onEditKey(e) {
      const k = e.key, ed = this.edit;
      // the IME owns Enter / arrows while composing; trust the event itself (a cancelled
      // composition may never send compositionend)
      if (e.isComposing || e.keyCode === 229) return;
      if (ed.list && (k === 'ArrowDown' || k === 'ArrowUp') && !e.altKey) { e.preventDefault(); this.moveList(k === 'ArrowDown' ? 1 : -1); }
      else if (k === 'ArrowDown' && e.altKey && ed.col.editor === 'date') { e.preventDefault(); this.openPicker(); }
      else if (k === 'Enter' && !e.altKey) { e.preventDefault(); this.commit(e.shiftKey ? 'up' : 'down'); }
      else if (k === 'Tab') { e.preventDefault(); this.commit(e.shiftKey ? 'left' : 'right'); }
      else if (k === 'Escape') { e.preventDefault(); this.cancel(); }
      else if (ed.mode === 'enter' && ARROWS[k]) { e.preventDefault(); this.commit(ARROWS[k]); }
    }

    // ---------------------------------------------------------------- editing
    startEdit(mode, initial) {
      const { r, c } = this.sel, col = this.cols[c], row = this.rows[r], isNew = this.isNewRow(r);
      if (!col || col.header) return;
      const editable = isNew ? col.key === 'subject' : col.editable?.(row);
      if (!editable) {
        // drop whatever was typed or composed so it cannot leak into the next cell
        this.proxy.value = '';
        this.composing = false;
        GX.toast(row && col.whyReadonly ? col.whyReadonly(row) : T('readonly_cell'), true);
        return;
      }
      Object.assign(this.sel, { ar: r, ac: c });
      const p = this.proxy;
      this.edit = { r, c, col, row, mode, isNew, list: col.editor === 'list' };
      if (initial !== null) p.value = mode === 'edit' && row ? this.textOf(col, row) : initial;
      this.root.classList.add('editing');
      p.classList.add('on');
      this.refresh();
      this.autosize();
      if (mode === 'edit') p.setSelectionRange(p.value.length, p.value.length);
      this.updateList();
      if (col.editor === 'date') this.showTip(p, T('date_hint'));
    }

    autosize() {
      if (!this.edit) return;
      const p = this.proxy;
      p.style.width = `${Math.max(this.edit.col.width, Math.min(480, p.value.length * 13 + 24))}px`;
    }

    commit(dir) {
      const ed = this.edit;
      if (!ed) return true;
      let text = this.proxy.value;
      if (ed.list && text.trim() && this.items?.[this.listSel]) text = this.items[this.listSel].label;
      if (ed.isNew) {
        this.closeEdit();
        if (text.trim()) this.o.onCreate?.(this.rows.at(-1) ?? null, [{ subject: text }]);
        this.afterCommitMove(dir);
        return true;
      }
      const res = ed.col.parse ? ed.col.parse(text, ed.row) : { value: text };
      if (res.error) {
        this.proxy.classList.add('bad');
        this.showTip(this.proxy, res.error);
        return false;
      }
      const before = this.textOf(ed.col, ed.row);
      this.closeEdit();
      if (String(text) !== String(before)) this.o.onEdit?.([{ row: ed.row, key: ed.col.key, value: res.value, text }]);
      this.afterCommitMove(dir);
      return true;
    }
    afterCommitMove(dir) {
      const d = MOVES[dir];
      if (d) this.move(...d); else this.focus();
    }
    cancel() { this.closeEdit(); this.focus(); }
    closeEdit() {
      this.edit = null;
      this.proxy.value = '';
      this.proxy.classList.remove('on', 'bad');
      this.root.classList.remove('editing');
      this.list.style.display = 'none';
      this.items = null;
      this.hideTip();
      this.refresh();
    }

    // suggestion list for list editors (assignee)
    updateList() {
      const ed = this.edit;
      if (!ed?.list) { this.list.style.display = 'none'; return; }
      const q = this.proxy.value.trim().toLowerCase();
      const items = (ed.col.options?.(ed.row) ?? []).filter((it) => !q || it.label.toLowerCase().includes(q));
      this.items = items;
      this.listSel = items.length ? 0 : null;
      this.list.innerHTML = items.map((it, i) =>
        `<div class="gx-li${i === 0 ? ' on' : ''}" data-label="${esc(it.label)}">${esc(it.label)}${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</div>`).join('');
      this.list.style.display = items.length ? 'block' : 'none';
      this.placeList();
    }
    moveList(d) {
      if (!this.items?.length) return;
      this.listSel = (this.listSel + d + this.items.length) % this.items.length;
      this.list.querySelectorAll('.gx-li').forEach((li, i) => li.classList.toggle('on', i === this.listSel));
    }
    placeList() {
      if (this.list.style.display !== 'block') return;
      const p = this.proxy.style;
      Object.assign(this.list.style, { left: p.left, top: `${parseFloat(p.top) + parseFloat(p.height)}px` });
    }
    openPicker() {
      const ed = this.edit, d = ed?.col.parse?.(this.proxy.value, ed.row);
      this.picker.value = d?.value != null ? GX.toStr(d.value) : '';
      Object.assign(this.picker.style, { left: this.proxy.style.left, top: this.proxy.style.top });
      try { this.picker.showPicker(); } catch { this.picker.focus(); }
    }
    showTip(anchor, text) {
      if (!text) { this.hideTip(); return; }
      const rr = this.root.getBoundingClientRect(), ar = anchor.getBoundingClientRect();
      this.tip.textContent = text;
      Object.assign(this.tip.style, { display: 'block', left: `${ar.left - rr.left}px`, top: `${ar.bottom - rr.top + 4}px` });
    }
    hideTip() { this.tip.style.display = 'none'; }

    // ---------------------------------------------------------------- clipboard, fill, clear
    copy(e, cut) {
      const g = this.range();
      const out = this.rows.slice(g.r1, g.r2 + 1).map((row) =>
        this.cols.slice(g.c1, g.c2 + 1).map((col) => (col.copyText ? col.copyText(row) : this.textOf(col, row))));
      e.clipboardData.setData('text/plain', GX.toTSV(out));
      e.preventDefault();
      if (cut) this.clearRange();
    }

    // Applies a matrix of texts starting at (r0, c0). Rows past the end become new tasks.
    applyMatrix(m, r0, c0) {
      const changes = [], creates = [], errs = {};
      let bad = 0;
      m.forEach((line, i) => {
        const r = r0 + i;
        if (r >= this.rows.length) {
          creates.push(Object.fromEntries(line.slice(0, this.cols.length - c0).map((v, j) => [this.cols[c0 + j].key, v])));
          return;
        }
        const row = this.rows[r];
        line.forEach((text, j) => {
          const c = c0 + j, col = this.cols[c];
          if (!col || col.header) return;
          if (!col.editable?.(row)) {
            if ((col.copyText ? col.copyText(row) : col.text(row)) !== text) {
              errs[`${r}:${c}`] = col.whyReadonly ? col.whyReadonly(row) : T('readonly_cell');
              bad++;
            }
            return;
          }
          const res = col.parse ? col.parse(text, row) : { value: text };
          if (res.error) { errs[`${r}:${c}`] = res.error; bad++; return; }
          if (String(this.textOf(col, row)) !== String(text)) changes.push({ row, key: col.key, value: res.value, text });
        });
      });
      this.errs = errs;
      this.refresh();
      if (changes.length) this.o.onEdit?.(changes);
      if (creates.length) this.o.onCreate?.(this.rows.at(-1) ?? null, creates);
      return bad;
    }

    paste(e) {
      const text = e.clipboardData.getData('text/plain');
      e.preventDefault();
      if (!text) return;
      let m = GX.parseTSV(text);
      const g = this.range();
      // one value into a range fills the whole range (like Excel)
      if (m.length === 1 && m[0].length === 1 && (g.r2 > g.r1 || g.c2 > g.c1)) {
        m = Array.from({ length: g.r2 - g.r1 + 1 }, () => Array(g.c2 - g.c1 + 1).fill(m[0][0]));
      }
      const bad = this.applyMatrix(m, g.r1, g.c1);
      if (bad) GX.toast(T('paste_errors', { n: bad }), true);
    }

    fillDown() {
      const g = this.range();
      if (g.r2 === g.r1) return;
      const src = this.rows[g.r1];
      const line = this.cols.slice(g.c1, g.c2 + 1).map((col) => this.textOf(col, src));
      this.applyMatrix(Array.from({ length: g.r2 - g.r1 }, () => line), g.r1 + 1, g.c1);
    }

    startFill(e) {
      const g = this.range(), y0 = e.clientY;
      let last = g.r2;
      const guide = el('div', { class: 'gx-fillguide' });
      this.rowsEl.append(guide);
      const x = this.cols.slice(0, g.c1).reduce((a, c) => a + c.width, 0);
      const w = this.cols.slice(g.c1, g.c2 + 1).reduce((a, c) => a + c.width, 0);
      const draw = () => { guide.style.cssText = `left:${x}px;top:${g.r1 * this.RH}px;width:${w}px;height:${(last - g.r1 + 1) * this.RH}px`; };
      draw();
      const mv = (ev) => {
        last = Math.max(g.r2, Math.min(this.rows.length - 1, g.r2 + Math.round((ev.clientY - y0) / this.RH)));
        draw();
      };
      const up = () => {
        document.removeEventListener('mousemove', mv);
        document.removeEventListener('mouseup', up);
        guide.remove();
        if (last <= g.r2) return;
        const h = g.r2 - g.r1 + 1;
        const m = [];
        for (let r = g.r2 + 1; r <= last; r++) {
          const src = this.rows[g.r1 + ((r - g.r2 - 1) % h)];
          m.push(this.cols.slice(g.c1, g.c2 + 1).map((col) => this.textOf(col, src)));
        }
        Object.assign(this.sel, { ar: g.r1, r: last });
        this.applyMatrix(m, g.r2 + 1, g.c1);
      };
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
    }

    clearRange() {
      const g = this.range(), changes = [];
      for (const row of this.rows.slice(g.r1, g.r2 + 1)) {
        for (const col of this.cols.slice(g.c1, g.c2 + 1)) {
          if (!col.clearable || !col.editable?.(row) || this.textOf(col, row) === '') continue;
          const res = col.parse('', row);
          if (!res.error) changes.push({ row, key: col.key, value: res.value, text: '' });
        }
      }
      if (changes.length) this.o.onEdit?.(changes);
    }
  }

  GX.Grid = Grid;
})();
