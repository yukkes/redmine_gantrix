/* 工程表 (Schedule) for Redmine (MIT License)
 * timeline: the gantt part of each grid row (bars), its header, background and overlay
 * (dependency arrows, progress line). Drawn inside the grid rows, so heights and scrolling
 * always match the table. */
(() => {
  'use strict';
  const GX = window.Gantrix;
  const { T, esc, el } = GX;
  const ZOOM = { day: 22, week: 9, month: 3 };

  // ctx: { cal, today, baseDay, firstDay, lastDay, zoom, dayWidth?, rowHeight, rows(), indexOf(id), relations,
  //        baseline, versions, statusOf(task) -> { name, kind, color }, showInazuma, showCritical, preview (Map id -> [s, e]),
  //        editable, canLink, onBarChange(row, start, end, mode, wd), onLink(fromId, toId), onDepClick(rel, event) }
  class Timeline {
    constructor(ctx) { this.ctx = ctx; }
    get dw() { return this.ctx.dayWidth ?? ZOOM[this.ctx.zoom] ?? ZOOM.day; }
    get laneLabel() { return T('milestones'); }
    width() { return (this.ctx.lastDay - this.ctx.firstDay + 1) * this.dw; }
    x(d) { return (d - this.ctx.firstDay) * this.dw; }
    // x within the drawn period (a few pixels past its ends at most), for lines that reach outside it
    cx(d) { return Math.max(-8, Math.min(this.x(d), this.width() + 8)); }
    // the drawn part of a period: { x, w, l, r } (l / r: cut at the left / right end), null when outside
    clip(s, e) {
      const c = this.ctx;
      if (e < c.firstDay || s > c.lastDay) return null;
      const a = Math.max(s, c.firstDay), b = Math.min(e, c.lastDay);
      return { x: this.x(a), w: (b - a + 1) * this.dw, l: s < c.firstDay, r: e > c.lastDay };
    }

    headerHTML(H) {
      const c = this.ctx, dw = this.dw, rowH = Math.floor(H / 3), out = [];
      // months (years when zoomed out)
      let seg = c.firstDay;
      for (let d = c.firstDay; d <= c.lastDay + 1; d++) {
        const a = GX.dt(seg), b = d <= c.lastDay ? GX.dt(d) : null;
        const split = !b || (c.zoom === 'month' ? b.getUTCFullYear() !== a.getUTCFullYear() : b.getUTCMonth() !== a.getUTCMonth());
        if (!split) continue;
        const w = (d - seg) * dw;
        const label = w > 56 ? (c.zoom === 'month' ? String(a.getUTCFullYear()) : GX.fmtYM(a.getUTCFullYear(), a.getUTCMonth() + 1)) : '';
        out.push(`<div class="gx-tl-m" style="left:${this.x(seg)}px;width:${w}px;height:${rowH}px">${esc(label)}</div>`);
        seg = d;
      }
      // days / weeks / months
      for (let d = c.firstDay; d <= c.lastDay; d++) {
        const x = GX.dt(d), wd = x.getUTCDay(), hol = c.cal.holidays[d];
        let label = null, width = dw, cls = 'gx-tl-d';
        if (c.zoom === 'day') {
          label = x.getUTCDate();
          cls += `${wd === 0 || hol ? ' sun' : wd === 6 ? ' sat' : ''}${d === c.today ? ' today' : ''}`;
        } else if (c.zoom === 'week' && wd === 1) {
          label = `${x.getUTCMonth() + 1}/${x.getUTCDate()}`;
          width = dw * 7;
        } else if (c.zoom === 'month' && x.getUTCDate() === 1) {
          label = GX.fmtMonth(x.getUTCMonth() + 1);
          width = dw * new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate();
        }
        if (label != null) {
          out.push(`<div class="${cls}" style="left:${this.x(d)}px;width:${width}px;top:${rowH}px;height:${rowH}px"${hol ? ` title="${esc(hol)}"` : ''}>${label}</div>`);
        }
      }
      // milestone lane (versions with a due date)
      for (const v of c.versions ?? []) {
        const vd = GX.toDay(v.date);
        if (vd < c.firstDay || vd > c.lastDay) continue;
        out.push(`<div class="gx-tl-ms" style="left:${this.x(vd) + dw / 2}px;top:${rowH * 2}px;height:${H - rowH * 2}px" title="${esc(`${v.name} ${GX.fmtDay(vd)}`)}"><i></i><span>${esc(v.name)}</span></div>`);
      }
      return out.join('');
    }

    bgHTML() {
      const c = this.ctx, dw = this.dw, out = [];
      if (c.zoom !== 'month') {
        for (let d = c.firstDay; d <= c.lastDay; d++) {
          if (!c.cal.isWorking(d)) out.push(`<div class="gx-tl-off" style="left:${this.x(d)}px;width:${dw}px"></div>`);
        }
      }
      for (const v of c.versions ?? []) {
        const vd = GX.toDay(v.date);
        if (vd >= c.firstDay && vd <= c.lastDay) out.push(`<div class="gx-tl-msline" style="left:${this.x(vd) + dw / 2}px"></div>`);
      }
      if (c.today >= c.firstDay && c.today <= c.lastDay) out.push(`<div class="gx-tl-today" style="left:${this.x(c.today) + dw / 2}px"></div>`);
      return out.join('');
    }

    critical(t) { return !!this.ctx.showCritical && t.slack != null && t.slack <= 0; }

    rowHTML(row) {
      const c = this.ctx, t = row.task, out = [];
      if (!t) return '';
      const cut = (p) => `${p.l ? ' cut-l' : ''}${p.r ? ' cut-r' : ''}`;
      const ghost = c.preview?.get(t.id), g = ghost && this.clip(ghost[0], ghost[1]);
      if (g) out.push(`<div class="gx-tl-ghost" style="left:${g.x}px;width:${g.w}px"></div>`);
      const b = c.baseline?.[t.id], bp = b?.[0] != null && b[1] != null && !row.hasChildren && this.clip(b[0], b[1]);
      if (bp) {
        out.push(`<div class="gx-tl-base" style="left:${bp.x}px;width:${bp.w}px" title="${esc(T('baseline_period', { s: GX.toStr(b[0]), e: GX.toStr(b[1]) }))}"></div>`);
      }
      if (t.s != null && t.e != null) {
        const prog = row.progress, p = this.clip(t.s, t.e);
        const title = esc(`${t.subject}\n${T('planned_period', { s: GX.toStr(t.s), e: GX.toStr(t.e), n: row.days })}\n${T('progress_pct', { p: prog })}\n${T('bar_open_tip')}`);
        if (!p) {
          // wholly outside the drawn period: a mark at the end it lies beyond
          const right = t.s > c.lastDay;
          out.push(`<i class="gx-tl-out ${right ? 'r' : 'l'}" data-id="${t.id}" style="left:${right ? this.width() - 12 : 0}px" title="${title}"></i>`);
        } else if (row.hasChildren) {
          out.push(`<div class="gx-tl-bar parent${cut(p)}" data-id="${t.id}" style="left:${p.x}px;width:${Math.max(p.w, 3)}px" title="${title}"><b style="width:${prog}%"></b></div>`);
        } else {
          const x1 = p.x, w = Math.max(p.w, 3);
          const cls = ['gx-tl-bar', row.late && 'late', t.closed && 'closed', this.critical(t) && 'critical'].filter(Boolean).join(' ') + cut(p);
          // a bar cut at an end cannot be dragged there: no handle on that side
          out.push(`<div class="${cls}" data-id="${t.id}" style="left:${x1}px;width:${w}px" title="${title}"><b style="width:${prog}%"></b>${p.l ? '' : '<i class="gx-tl-h l"></i>'}${p.r ? '' : '<i class="gx-tl-h r"></i>'}</div>`);
          // drag this dot onto another bar to make that task a successor
          if (c.canLink && !p.r) out.push(`<i class="gx-tl-link" data-id="${t.id}" style="left:${x1 + w + 2}px" title="${esc(T('link_drag_tip'))}"></i>`);
          const st = c.statusOf(t);
          if (st && c.zoom !== 'month' && !p.r) {
            const color = st.color ? `;--st:${st.color}` : '';
            out.push(`<span class="gx-tl-label gx-st-${st.kind}" style="left:${x1 + w + 6}px${color}"><i></i>${esc(st.name)} ${prog}%</span>`);
          }
        }
      }
      if (t.as != null && !row.hasChildren) {
        const ae = t.ae ?? Math.max(c.baseDay, t.as), ap = this.clip(t.as, ae);
        const title = esc(T('actual_period', { s: GX.toStr(t.as), e: t.ae != null ? GX.toStr(t.ae) : T('in_progress') }));
        if (ap) out.push(`<div class="gx-tl-act${t.ae == null ? ' open' : ''}" style="left:${ap.x}px;width:${ap.w}px" title="${title}"></div>`);
      }
      return out.join('');
    }

    // dependency arrows + progress line for the rendered window
    overlay(svg, first, last, forPrint = false) {
      const c = this.ctx, RH = c.rowHeight, dw = this.dw, rows = c.rows(), lo = first - 40, hi = last + 40;
      const out = ['<defs><marker id="gx-tl-ar" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L8,4 L0,8 z" class="gx-tl-arrowhead"/></marker></defs>'];
      for (const rel of c.relations ?? []) {
        const ia = c.indexOf(rel.from), ib = c.indexOf(rel.to);
        if (ia == null || ib == null || (ia < lo && ib < lo) || (ia > hi && ib > hi)) continue;
        const a = rows[ia].task, b = rows[ib].task;
        if (a.e == null || b.s == null) continue;
        const x1 = this.cx(a.e + 1), y1 = ia * RH + RH / 2, x2 = this.cx(b.s), y2 = ib * RH + RH / 2;
        const straight = x2 >= x1 + 10;
        const d = straight
          ? `M${x1},${y1} H${x1 + 5} V${y2} H${x2}`
          : `M${x1},${y1} H${x1 + 5} V${y2 + (y2 > y1 ? -RH / 2 : RH / 2)} H${x2 - 8} V${y2} H${x2}`;
        // the clickable part leaves both ends free for the link dot and the resize handle of the bars
        const hy = y1 + (y2 > y1 ? 8 : -8);
        const hit = straight
          ? `M${x1 + 5},${hy} V${y2} H${Math.max(x1 + 5, x2 - 8)}`
          : `M${x1 + 5},${hy} V${y2 + (y2 > y1 ? -RH / 2 : RH / 2)} H${x2 - 8} V${y2}`;
        const crit = this.critical(a) && this.critical(b) ? ' crit' : '';
        out.push(`<path d="${d}" class="gx-tl-dep${b.s <= a.e ? ' bad' : ''}${crit}" marker-end="url(#gx-tl-ar)"/>`);
        if (c.onDepClick && !forPrint) out.push(`<path d="${hit}" class="gx-tl-dep-hit" data-rel="${rel.id}"><title>${esc(T('link_click_tip'))}</title></path>`);
      }
      if (c.showInazuma) {
        // on schedule = the end of the base day; drawn half a day earlier, so its vertical line is the today line
        // (in the middle of the day) and every point keeps its distance from it
        const half = dw / 2, bx = this.x(c.baseDay + 1) - half, pts = [[bx, first * RH]];
        for (let i = first; i < Math.min(last, rows.length); i++) {
          const r = rows[i], t = r.task;
          if (r.hasChildren || t.s == null || t.e == null) continue;
          const p = r.progress;
          const px = (p >= 100 && t.e <= c.baseDay) || (p === 0 && t.s > c.baseDay) ? bx
            : Math.max(-8, Math.min(this.x(t.s) + (t.e - t.s + 1) * dw * p / 100 - half, this.width() + 8));
          pts.push([px, i * RH + RH / 2]);
        }
        pts.push([bx, Math.min(last, rows.length) * RH]);
        out.push(`<polyline class="gx-tl-inazuma" points="${pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')}"/>`);
      }
      svg.innerHTML = out.join('');
      if (!forPrint && svg !== this.svg) {
        this.svg = svg;
        // click (not mousedown): the menu it opens must survive the "click outside closes menus" handler
        svg.addEventListener('click', (e) => {
          const hit = e.target.closest?.('.gx-tl-dep-hit');
          const rel = hit && this.ctx.relations?.find((r) => String(r.id) === hit.dataset.rel);
          if (!rel) return;
          e.preventDefault();
          e.stopPropagation();
          this.ctx.onDepClick?.(rel, e);
        });
      }
    }

    // drag from the dot after a bar to another bar: a new "precedes" relation
    startLink(e, dot) {
      const c = this.ctx, svg = this.svg, from = +dot.dataset.id;
      if (!svg) return;
      const box = () => svg.getBoundingClientRect();
      const r0 = dot.getBoundingClientRect(), b0 = box();
      const x0 = r0.left + r0.width / 2 - b0.left, y0 = r0.top + r0.height / 2 - b0.top;
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      line.setAttribute('class', 'gx-tl-dep linking');
      line.setAttribute('marker-end', 'url(#gx-tl-ar)');
      svg.append(line);
      let target = null;
      const mv = (ev) => {
        const b = box();
        line.setAttribute('d', `M${x0},${y0} L${ev.clientX - b.left},${ev.clientY - b.top}`);
        const bar = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('.gx-tl-bar');
        const id = bar && +bar.dataset.id !== from && !bar.classList.contains('parent') ? bar : null;
        if (id !== target) { target?.classList.remove('link-target'); id?.classList.add('link-target'); target = id; }
      };
      const up = () => {
        document.removeEventListener('mousemove', mv);
        document.removeEventListener('mouseup', up);
        line.remove();
        target?.classList.remove('link-target');
        if (target) c.onLink?.(from, +target.dataset.id);
      };
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
    }

    // drag a bar: body = move (keeps the working days), ends = change start / finish
    onMouseDown(e, row, r, target = e.target) {
      if (target.classList?.contains('gx-tl-link')) { e.preventDefault(); this.startLink(e, target); return true; }
      const bar = target.closest?.('.gx-tl-bar');
      if (!bar || !row || !this.ctx.editable) return false;
      // a bar cut at an end of the period: edit its dates in the table
      if (bar.classList.contains('cut-l') || bar.classList.contains('cut-r')) return false;
      e.preventDefault();
      const c = this.ctx, t = row.task, dw = this.dw, x0 = e.clientX;
      let mode = target.classList.contains('r') ? 'end' : target.classList.contains('l') ? 'start' : 'move';
      if (row.hasChildren) mode = 'move';
      const left0 = bar.offsetLeft, width0 = bar.offsetWidth;
      const tip = el('div', { class: 'gx-tl-tip' });
      bar.parentNode.append(tip);
      let delta = 0;
      const result = () => {
        if (mode === 'move') {
          const s = c.cal.nextWorking(t.s + delta);
          return { s, e: c.cal.step(s, c.cal.workingDays(t.s, t.e) - 1) };
        }
        if (mode === 'end') return { s: t.s, e: Math.max(t.s, t.e + delta) };
        return { s: Math.min(t.e, t.s + delta), e: t.e };
      };
      const mv = (ev) => {
        delta = Math.round((ev.clientX - x0) / dw);
        if (mode !== 'end') bar.style.left = `${left0 + delta * dw}px`;
        if (mode === 'end') bar.style.width = `${Math.max(dw, width0 + delta * dw)}px`;
        if (mode === 'start') bar.style.width = `${Math.max(dw, width0 - delta * dw)}px`;
        bar.classList.add('drag');
        const r = result();
        tip.textContent = `${GX.range(GX.fmtDay(r.s), GX.fmtDay(r.e))}${T('gap')}${T('days_n', { n: c.cal.workingDays(r.s, r.e) })}${delta ? `${T('gap')}${delta > 0 ? '+' : ''}${delta}` : ''}`;
        tip.style.left = `${bar.offsetLeft}px`;
      };
      const up = () => {
        document.removeEventListener('mousemove', mv);
        document.removeEventListener('mouseup', up);
        tip.remove();
        if (!delta) { bar.classList.remove('drag'); return; }
        const r = result();
        c.onBarChange(row, r.s, r.e, mode, mode === 'move' ? c.cal.between(t.s, r.s) : 0);
      };
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
      return true;
    }
  }

  GX.Timeline = Timeline;
  GX.ZOOM = ZOOM;
})();
