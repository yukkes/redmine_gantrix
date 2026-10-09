/* 工程表 (Schedule) for Redmine (MIT License)
 * kanban: leaf tasks in status columns. Dropping a card on a column changes the status through
 * the schedule's API; columns the workflow does not allow are dimmed while dragging. */
(() => {
  'use strict';
  const GX = window.Gantrix;
  const { T, el } = GX;
  const FILTERS = ['this_week', 'doing', 'mine'];

  class Kanban {
    constructor(root) {
      this.root = root;
      this.cfg = JSON.parse(root.dataset.config);
      GX.setMessages(this.cfg.messages);
      this.key = `gantrix-kanban:${this.cfg.project}`;
      const saved = GX.store(this.key) ?? {};
      this.filters = new Set(saved.filters ?? []);
      this.versionId = saved.versionId ?? '';
      this.load();
    }

    save() { GX.store(this.key, { filters: [...this.filters], versionId: this.versionId }); }

    async load() {
      this.root.classList.add('busy');
      try {
        const res = await fetch(this.cfg.dataUrl, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        this.data = await res.json();
        if (this.versionId && !this.data.versions.some((v) => String(v.id) === String(this.versionId))) this.versionId = '';
        this.render();
      } catch (e) {
        GX.toast(T('load_failed') + e.message, true);
      } finally {
        this.root.classList.remove('busy');
      }
    }

    year() { return GX.dt(GX.toDay(this.data.today)).getUTCFullYear(); }
    day(s) { return s ? GX.fmtDay(GX.toDay(s), this.year()) : ''; }

    visible(c) {
      const d = this.data, today = GX.toDay(d.today), monday = today - ((GX.wday(today) + 6) % 7);
      if (this.filters.has('this_week') && !(c.start_date && GX.toDay(c.start_date) >= monday && GX.toDay(c.start_date) <= monday + 6)) return false;
      if (this.filters.has('doing') && !(c.done_ratio > 0 && c.done_ratio < 100)) return false;
      if (this.filters.has('mine') && c.assigned_to_id !== d.me) return false;
      if (this.versionId && String(c.fixed_version_id) !== String(this.versionId)) return false;
      return true;
    }

    render() {
      const d = this.data;
      const chips = FILTERS.map((f) => el('button', {
        type: 'button', class: `gx-kb-chip${this.filters.has(f) ? ' on' : ''}`, 'aria-pressed': String(this.filters.has(f)), text: T(`kanban_${f}`),
        onclick: () => { if (this.filters.has(f)) this.filters.delete(f); else this.filters.add(f); this.save(); this.render(); },
      }));
      const version = el('select', { class: `gx-select gx-kb-version${this.versionId ? ' on' : ''}`, onchange: (e) => { this.versionId = e.target.value; this.save(); this.render(); } },
        [el('option', { value: '', text: T('kanban_all_versions') }), ...d.versions.map((v) => el('option', { value: v.id, text: v.name }))]);
      version.value = this.versionId;
      const cards = d.cards.filter((c) => this.visible(c));
      const board = el('div', { class: 'gx-kb-board' }, d.statuses.map((s) => this.column(s, cards.filter((c) => c.status_id === s.id))));
      this.root.replaceChildren(
        el('div', { class: 'gx-kb-filters' }, [...chips, version]),
        el('p', { class: 'gx-kb-note', text: d.can_edit ? T('kanban_note') : T('kanban_readonly') }),
        board,
      );
      this.board = board;
    }

    column(s, cards) {
      const hours = cards.reduce((a, c) => a + (+c.estimated_hours || 0), 0);
      const col = el('section', { class: `gx-kb-col${s.closed ? ' closed' : ''}`, 'data-status': s.id, style: `--st:${s.color}` }, [
        el('header', {}, [el('b', { text: s.name }), el('span', { text: T('count_n', { n: cards.length }) }), hours ? el('span', { text: `${Math.round(hours * 10) / 10}h` }) : null]),
        el('div', { class: 'gx-kb-cards' }, cards.map((c) => this.card(c, s))),
      ]);
      if (this.data.can_add && s.id === this.data.default_status_id) col.append(this.adder());
      col.addEventListener('dragover', (e) => {
        if (!this.drag || !col.classList.contains('ok')) return;
        e.preventDefault();
        col.classList.add('over');
      });
      col.addEventListener('dragleave', (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('over'); });
      col.addEventListener('drop', (e) => {
        e.preventDefault();
        col.classList.remove('over');
        if (this.drag && col.classList.contains('ok')) this.move(this.drag, s);
      });
      return col;
    }

    card(c, s) {
      const n = el('article', { class: `gx-kb-card${c.overdue ? ' late' : ''}`, draggable: this.data.can_edit && c.allowed.length ? 'true' : 'false', 'data-id': c.id }, [
        el('div', { class: 'gx-kb-path', text: `#${c.id}${T('gap')}${c.path ?? ''}` }),
        el('a', { class: 'gx-kb-subj', href: `${this.cfg.issuesUrl}/${c.id}`, text: c.subject, draggable: 'false' }),
        el('div', { class: 'gx-kb-prog' }, [el('span', { class: 'gx-kb-bar' }, [el('b', { style: `width:${c.done_ratio}%` })]), el('span', { text: `${c.done_ratio}%` })]),
        el('div', { class: 'gx-kb-foot' }, [
          el('span', { class: c.overdue ? 'gx-kb-due late' : 'gx-kb-due', text: c.due_date ? T('kanban_due', { d: this.day(c.due_date) }) : '' }),
          el('span', { class: c.estimated_hours ? 'gx-kb-est' : 'gx-kb-est none', text: c.estimated_hours ? `${+c.estimated_hours}h` : T('kanban_no_estimate') }),
          el('span', { class: `gx-kb-who${c.assigned_to ? '' : ' none'}`, title: c.assigned_to ?? T('no_assignee'), text: c.assigned_to ? c.assigned_to.trim()[0] : '?' }),
        ]),
        c.overdue ? el('span', { class: 'gx-kb-flag', text: T('kanban_overdue') }) : null,
      ]);
      n.addEventListener('dragstart', (e) => {
        this.drag = c;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(c.id));
        n.classList.add('dragging');
        for (const col of this.board.querySelectorAll('.gx-kb-col')) {
          const id = +col.dataset.status;
          col.classList.toggle('ok', c.allowed.includes(id));
          col.classList.toggle('no', id !== s.id && !c.allowed.includes(id));
        }
        this.board.classList.add('dragging');
      });
      n.addEventListener('dragend', () => {
        n.classList.remove('dragging');
        this.board.classList.remove('dragging');
        for (const col of this.board.querySelectorAll('.gx-kb-col')) col.classList.remove('ok', 'no', 'over');
        this.drag = null;
      });
      return n;
    }

    async move(c, s) {
      this.drag = null;
      try {
        await GX.api(this.cfg.apiUrl, 'PATCH', `/tasks/${c.id}`, { task: { status_id: String(s.id) } });
        GX.toast(T('kanban_moved', { subject: c.subject, status: s.name }));
      } catch (e) {
        GX.toast(e.message, true);
      }
      await this.load();
    }

    adder() {
      const input = el('input', { type: 'text', class: 'gx-input', placeholder: T('kanban_add_ph'), hidden: true });
      const open = el('button', { type: 'button', class: 'gx-kb-add', onclick: () => { open.hidden = true; input.hidden = false; input.focus(); } },
        [GX.icon('plus'), ` ${T('kanban_add')}`]);
      input.addEventListener('keydown', async (e) => {
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === 'Escape') { input.hidden = true; open.hidden = false; return; }
        if (e.key !== 'Enter' || !input.value.trim()) return;
        try {
          await GX.api(this.cfg.apiUrl, 'POST', '/tasks', { subject: input.value.trim() });
          GX.toast(T('kanban_added'));
          await this.load();
        } catch (err) {
          GX.toast(err.message, true);
        }
      });
      return el('div', { class: 'gx-kb-adder' }, [open, input]);
    }
  }

  const start = () => {
    const root = document.getElementById('gantrix-kanban');
    if (root) root.kanban = new Kanban(root);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
