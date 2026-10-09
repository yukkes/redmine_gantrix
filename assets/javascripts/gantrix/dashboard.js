/* 工程表 (Schedule) for Redmine (MIT License)
 * dashboard: today's topics (overdue, behind, not started, no assignee, no estimate) with quick
 * fixes that save through the schedule's API, plus milestones, this week's load and recent changes. */
(() => {
  'use strict';
  const GX = window.Gantrix;
  const { T, esc, el } = GX;
  const KINDS = ['overdue', 'behind', 'not_started', 'unassigned', 'no_estimate'];

  class Dashboard {
    constructor(root) {
      this.root = root;
      this.cfg = JSON.parse(root.dataset.config);
      GX.setMessages(this.cfg.messages);
      this.kind = GX.urlParam('topic');
      this.open = null; // { id, mode } of the card being fixed
      this.load();
    }

    async load() {
      this.root.classList.add('busy');
      try {
        const res = await fetch(this.cfg.dataUrl, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        this.data = await res.json();
        // start on the first topic that has tasks
        if (!this.kind || !this.data.topics[this.kind]) this.kind = KINDS.find((k) => this.data.topics[k].length) ?? 'overdue';
        this.render();
      } catch (e) {
        GX.toast(T('load_failed') + e.message, true);
      } finally {
        this.root.classList.remove('busy');
      }
    }

    year() { return GX.dt(GX.toDay(this.data.today)).getUTCFullYear(); }
    day(s) { return s ? GX.fmtDay(GX.toDay(s), this.year()) : T('no_value'); }
    canEdit() { return this.data.can_edit && !!this.cfg.apiUrl; }

    render() {
      const d = this.data;
      const tiles = el('div', { class: 'gx-db-topics', role: 'tablist' }, KINDS.map((k) => {
        const n = d.topics[k].length;
        return el('button', {
          type: 'button', role: 'tab', class: `gx-db-topic ${k}${n ? ' some' : ''}${this.kind === k ? ' on' : ''}`, 'aria-selected': String(this.kind === k),
          onclick: () => { this.kind = k; this.open = null; GX.setUrlParams({ topic: k }); this.render(); },
        }, [el('span', { class: 'n', text: String(n) }), el('span', { class: 'l', text: T(`topic_${k}`) }), el('span', { class: 's', text: T(`topic_${k}_sub`) })]);
      }));
      const ids = d.topics[this.kind];
      const list = el('div', { class: 'gx-db-list' }, ids.length ? ids.map((id) => this.card(d.cards[id])) : [el('p', { class: 'gx-db-empty', text: T('topic_none') })]);
      const head = el('div', { class: 'gx-db-list-head' }, [
        el('h3', { text: T('paren', { text: T(`topic_${this.kind}`), note: T('count_n', { n: ids.length }) }) }),
        this.cfg.scheduleUrl ? el('a', { href: this.cfg.scheduleUrl, text: T('open_schedule') }) : null,
      ]);
      this.root.replaceChildren(
        el('div', { class: 'gx-db-date', text: T('as_of', { d: this.day(d.today) }) }),
        el('div', { class: 'gx-db-title' }, [el('h3', { text: T('topics_title') }), el('span', { text: T('topics_hint') })]),
        tiles,
        el('div', { class: 'gx-db-cols' }, [el('div', { class: 'gx-db-main' }, [head, list]), this.side()]),
      );
    }

    card(c) {
      const color = this.data.status_colors[c.status_id] ?? '#8c959f';
      const planned = c.planned ?? 0;
      const late = c.done_ratio < planned || (c.due_date && c.due_date < this.data.today);
      const buttons = this.canEdit()
        ? [['comment', 'fix_comment', !this.data.can_comment], ['assignee', 'fix_assignee'], ['due', 'fix_due'], ['progress', 'fix_progress']].map(([mode, label, off]) =>
          el('button', { type: 'button', class: `gx-btn${mode === 'progress' ? ' primary' : ''}${this.open?.id === c.id && this.open.mode === mode ? ' on' : ''}`, disabled: !!off,
            text: T(label), onclick: () => { this.open = this.open?.id === c.id && this.open.mode === mode ? null : { id: c.id, mode }; this.render(); } }))
        : [];
      const box = el('div', { class: `gx-db-card${late ? ' late' : ''}` }, [
        el('div', { class: 'gx-db-card-top' }, [
          el('a', { class: 'gx-db-subj', href: `${this.cfg.issuesUrl}/${c.id}`, text: `${c.wbs ?? ''} ${c.subject}` }),
          el('span', { class: 'gx-db-id', text: `#${c.id}` }),
          el('span', { class: 'gx-db-btns' }, buttons),
        ]),
        el('div', { class: 'gx-db-meta' }, [
          el('span', { class: 'gx-db-who', text: c.assigned_to ?? T('no_assignee') }),
          el('span', { text: GX.range(this.day(c.start_date), this.day(c.due_date)) }),
          el('span', { class: 'gx-db-st', html: `<i style="background:${esc(color)}"></i>${esc(c.status)}` }),
          el('span', { class: 'gx-db-bar', title: T('progress_vs_plan', { a: c.done_ratio, p: planned }) },
            [el('b', { style: `width:${c.done_ratio}%` }), c.planned != null ? el('i', { style: `left:${planned}%` }) : null]),
          el('span', { class: `gx-db-pct${late ? ' late' : ''}`, text: c.planned != null ? T('progress_vs_plan', { a: c.done_ratio, p: planned }) : `${c.done_ratio}%` }),
        ]),
      ]);
      if (this.open?.id === c.id) box.append(this.editor(c));
      return box;
    }

    // the quick fix under a card
    editor(c) {
      const mode = this.open.mode, wrap = el('div', { class: 'gx-db-edit' });
      const save = (task, msg) => this.save(c.id, task, msg);
      if (mode === 'progress') {
        let value = c.done_ratio;
        const chips = el('span', { class: 'gx-db-chips' }, Array.from({ length: 11 }, (_, i) => i * 10).map((v) =>
          el('button', { type: 'button', class: `gx-db-chip${v === value ? ' on' : ''}`, text: `${v}%`, onclick: (e) => {
            value = v;
            for (const b of chips.children) b.classList.toggle('on', b === e.currentTarget);
          } })));
        const memo = el('input', { type: 'text', class: 'gx-input', placeholder: T('fix_memo_ph') });
        wrap.append(el('span', { class: 'gx-db-edit-label', text: T('fix_progress') }), chips,
          el('label', { class: 'gx-db-memo' }, [T('fix_memo'), memo]),
          el('button', { type: 'button', class: 'gx-btn primary', text: T('save'), onclick: () => {
            const task = { done_ratio: String(value) };
            if (memo.value.trim()) task.notes = memo.value.trim();
            if (value > 0 && c.done_ratio === 0) task.actual_start_date = this.data.today;
            if (value === 100) task.actual_end_date = this.data.today;
            save(task, T('saved_progress', { p: value }));
          } }),
          el('div', { class: 'gx-db-edit-note', text: T('fix_progress_note') }));
      } else if (mode === 'assignee') {
        const sel = el('select', { class: 'gx-input' }, [el('option', { value: '', text: T('no_assignee') }),
          ...this.data.users.map((u) => el('option', { value: u.id, text: u.name }))]);
        sel.value = c.assigned_to_id ?? '';
        wrap.append(el('span', { class: 'gx-db-edit-label', text: T('fix_assignee') }), sel,
          el('button', { type: 'button', class: 'gx-btn primary', text: T('save'), onclick: () => save({ assigned_to_id: sel.value }, T('saved')) }));
      } else if (mode === 'due') {
        const date = el('input', { type: 'date', class: 'gx-input', value: c.due_date ?? '' });
        wrap.append(el('span', { class: 'gx-db-edit-label', text: T('fix_due') }), date,
          el('button', { type: 'button', class: 'gx-btn primary', text: T('save'), onclick: () => {
            if (!date.value) { GX.toast(T('date_required'), true); return; }
            save({ due_date: date.value }, T('saved'));
          } }),
          el('div', { class: 'gx-db-edit-note', text: T('fix_due_note') }));
      } else {
        const notes = el('textarea', { class: 'gx-input', rows: 2, placeholder: T('fix_comment_ph') });
        wrap.append(el('span', { class: 'gx-db-edit-label', text: T('fix_comment') }), notes,
          el('button', { type: 'button', class: 'gx-btn primary', text: T('save'), onclick: () => {
            if (!notes.value.trim()) return;
            save({ notes: notes.value.trim() }, T('saved_comment'));
          } }));
      }
      requestAnimationFrame(() => wrap.querySelector('input, select, textarea')?.focus());
      return wrap;
    }

    async save(id, task, msg) {
      try {
        await GX.api(this.cfg.apiUrl, 'PATCH', `/tasks/${id}`, { task });
        GX.toast(msg);
        this.open = null;
        await this.load();
      } catch (e) {
        GX.toast(e.message, true);
      }
    }

    side() {
      const d = this.data;
      const ms = d.milestones.length
        ? d.milestones.map((m) => el('li', {}, [el('span', { class: 'gx-db-ms', text: `◆ ${m.name}` }), el('span', { text: this.day(m.date) })]))
        : [el('li', { class: 'gx-db-empty', text: T('no_milestones') })];
      const loads = d.load.length
        ? d.load.map((x) => {
          const p = x.capacity ? Math.round(x.hours / x.capacity * 100) : 0;
          const cls = p > 100 ? 'over' : p > 80 ? 'full' : '';
          return el('li', {}, [el('span', { class: 'gx-db-who', text: x.name }),
            el('span', { class: `gx-db-load ${cls}` }, [el('b', { style: `width:${Math.min(p, 100)}%` })]),
            el('span', { class: `gx-db-load-t ${cls}`, text: T('load_week_value', { h: x.hours, cap: x.capacity, p }) })]);
        })
        : [el('li', { class: 'gx-db-empty', text: T('load_none') })];
      const recent = d.recent.length
        ? d.recent.map((r) => el('li', {}, [
          el('span', { class: 'gx-db-time', text: `${this.day(r.at.slice(0, 10))} ${r.at.slice(11, 16)}` }),
          el('span', {}, [`${r.user ?? ''} `, el('a', { href: `${this.cfg.issuesUrl}/${r.issue_id}`, text: r.subject }), r.text ? `: ${r.text}` : '']),
        ]))
        : [el('li', { class: 'gx-db-empty', text: T('no_changes') })];
      return el('aside', { class: 'gx-db-side' }, [
        el('section', {}, [el('h3', { text: T('next_milestones') }), el('ul', { class: 'gx-db-ms-list' }, ms)]),
        el('section', {}, [el('h3', { text: T('week_load') }), el('ul', { class: 'gx-db-load-list' }, loads)]),
        el('section', {}, [el('h3', { text: T('recent_changes') }), el('ul', { class: 'gx-db-recent' }, recent)]),
      ]);
    }
  }

  const start = () => {
    const root = document.getElementById('gantrix-dashboard');
    if (root) root.dashboard = new Dashboard(root);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
