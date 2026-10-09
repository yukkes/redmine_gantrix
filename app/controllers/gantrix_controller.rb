# frozen_string_literal: true

class GantrixController < ApplicationController
  class Error < StandardError; end

  menu_item :gantrix

  TASK_COLUMNS = %w[id subject parent_id status closed assigned_to_id assigned_to start_date due_date done_ratio
                    estimated_hours status_id actual_start_date actual_end_date position spent_hours context slack
                    wbs hidden more].freeze
  # "in progress" view: the open tasks, except those dated more than this many days ago, and the tasks closed
  # within RECENT_CLOSED_DAYS
  OLD_OPEN_DAYS = 365
  RECENT_CLOSED_DAYS = 14
  before_action :find_project_by_project_id, :authorize
  helper :gantrix_pages
  before_action :ensure_fields
  before_action :find_task, only: %i[update_task destroy_task move_task place_task]

  rescue_from Error, Gantrix::Scheduler::Error do |e|
    render json: { error: e.message }, status: :unprocessable_entity
  end
  rescue_from ActiveRecord::StaleObjectError do
    render json: { error: l(:error_gantrix_conflict) }, status: :conflict
  end

  def show; end

  def data
    calendar = Gantrix::Calendar.from_settings
    rows = Gantrix::IssueRows.new(@project.issues.visible)
    all = rows.to_a
    all_ids = all.to_set(&:id)
    query = find_query
    # by the project rather than by thousands of issue ids, then narrowed to the issues shown
    in_project = @project.issues.select(:id)
    actuals = actual_dates(in_project)
    spent = TimeEntry.where(project_id: @project.id).where.not(issue_id: nil).group(:issue_id).sum(:hours)
    positions = Gantrix::Positions.for(in_project)
    # WBS numbers of all tasks, so that a number stays the same whatever is shown
    tree = Gantrix::Tree.new(all, positions: positions)
    # without a query, the "in progress" view unless "all" is asked for (a long-running project is mostly
    # closed tasks): the other tasks stay folded under their parents until they are unfolded
    needed = !query && params[:closed].to_s != '1'
    issues = all
    context = Set.new
    issues, context = filter_by_query(all, query) if query
    # open=all: every task unfolded ("expand all"); otherwise the ids of the tasks unfolded on the screen
    opened = params[:open] == 'all' ? all_ids : params[:open].to_s.split(',').to_set(&:to_i)
    issues = needed_tree(all, tree, opened) if needed
    ids = issues.to_set(&:id)
    precedes = IssueRelation.where(relation_type: IssueRelation::TYPE_PRECEDES, issue_from_id: in_project)
                            .select { |r| all_ids.include?(r.issue_from_id) && all_ids.include?(r.issue_to_id) }
    # every predecessor of a task shown, also hidden ones: editing the predecessors must not drop them
    relations = precedes.select { |r| ids.include?(r.issue_to_id) }
    floats = if needed
               Gantrix::CriticalPath.new(all, precedes, calendar).floats
             else
               Gantrix::CriticalPath.new(issues, relations.select { |r| ids.include?(r.issue_from_id) }, calendar).floats
             end
    holidays = calendar.holidays_between(*holiday_range(all))
    hidden = if needed && ids.size < all.size
               # counted with the holidays the screen gets, as the screen counts its own tasks
               screen = Gantrix::Calendar.new(non_working_wdays: Array(Setting.non_working_week_days).map(&:to_i),
                                              source: 'none', extra_holidays: holidays.keys)
               hidden_leaves(all, ids, tree, actuals, spent, screen)
             else
               { rollups: {}, summary: nil }
             end
    baselines = Gantrix::Baselines.list(@project)
    baseline = baselines.detect { |b| b['id'] == params[:baseline_id].to_s }
    snapshot = baseline ? Gantrix::History.snapshot(@project, Time.iso8601(baseline['at'])) : {}

    render json: {
      today: User.current.today,
      permissions: permissions,
      done_ratio_editable: Setting.issue_done_ratio == 'issue_field',
      parent_dates_derived: Setting.parent_issue_dates == 'derived',
      parent_done_ratio_derived: Setting.parent_issue_done_ratio == 'derived',
      hours_per_day: Gantrix::Preferences.hours_per_day,
      users: @project.assignable_users.map { |u| { id: u.id, name: u.name } },
      status_colors: Gantrix::StatusColors.map,
      # one array per task in the order of TASK_COLUMNS: a third of the size of objects with the same keys
      tasks: {
        columns: TASK_COLUMNS,
        rows: issues.map do |i|
          actual = actuals[i.id] || {}
          [i.id, i.subject, i.parent_id, rows.status_names[i.status_id], i.closed?, i.assigned_to_id,
           rows.assignee_names[i.assigned_to_id], i.start_date, i.due_date, i.done_ratio.to_i, i.estimated_hours,
           i.status_id, actual[:start], actual[:end], positions[i.id], spent[i.id].to_f.round(2),
           context.include?(i.id), floats[i.id], tree.wbs(i.id), hidden[:rollups][i.id],
           # subtasks not loaded: unfolding the task loads them
           needed && tree.children(i.id).any? { |c| ids.exclude?(c) }]
        end
      },
      # predecessors that are not shown: their WBS numbers
      hidden_wbs: relations.reject { |r| ids.include?(r.issue_from_id) }.to_h { |r| [r.issue_from_id, tree.wbs(r.issue_from_id)] },
      # what the "in progress" view left out: its number and the totals of its leaves for the summary
      needed: needed,
      hidden_count: all.size - issues.size,
      hidden_summary: hidden[:summary],
      queries: query_list,
      query_id: query&.id,
      statuses: IssueStatus.sorted.map { |st| { id: st.id, name: st.name, closed: st.is_closed } },
      versions: @project.shared_versions.open.select(&:effective_date).sort_by(&:effective_date)
                        .map { |v| { id: v.id, name: v.name, date: v.effective_date } },
      relations: relations.map { |r| { id: r.id, from: r.issue_from_id, to: r.issue_to_id, delay: r.delay.to_i } },
      baselines: baselines.map { |b| { id: b['id'], name: b['name'], at: b['at'] } },
      baseline_items: snapshot.to_h { |id, v| [id, [v['start_date'], v['due_date'], v['deleted']]] },
      trash: trash_installed?,
      calendar: {
        non_working_wdays: Array(Setting.non_working_week_days).map(&:to_i),
        holidays: holidays.transform_values { |n| holiday_name(n) }
      }
    }
  end

  # PUT api/preferences: the user's view settings for this project (kept in the user's preferences)
  def save_preferences
    Gantrix::Preferences.set(User.current, @project, params.fetch(:preferences, {}))
    render json: { ok: true }
  end

  def create_task
    require_permission(:add_issues)
    tracker = @project.trackers.sorted.find_by(id: params[:tracker_id]) || @project.trackers.sorted.first
    raise Error, l(:error_gantrix_no_tracker) unless tracker

    start = Gantrix::Calendar.from_settings.next_working_day(User.current.today)
    issue = Issue.new(project: @project, author: User.current)
    issue.tracker = tracker
    issue.safe_attributes = {
      'subject' => params[:subject].presence || l(:label_gantrix_new_task),
      'parent_issue_id' => params[:parent_id].presence,
      'start_date' => start.iso8601,
      'due_date' => start.iso8601
    }
    issue.status ||= tracker.default_status
    Issue.transaction do
      raise Error, issue.errors.full_messages.join(', ') unless issue.save

      sibs = ordered_siblings(issue.parent_id) - [issue.id]
      after = sibs.index(params[:after_id].to_i)
      sibs.insert(after ? after + 1 : sibs.size, issue.id)
      Gantrix::Positions.write(sibs)
    end
    render json: { id: issue.id }
  end

  def update_task
    Issue.transaction do
      reschedule = apply_update(@issue, params.require(:task))
      push_successors([@issue.id]) if reschedule
    end
    render json: { ok: true }
  end

  # PATCH api/tasks: { tasks: [{ id:, subject:, start_date:, ... }] } in one transaction
  # (paste, fill, undo). On error everything is rolled back and the failing row is reported.
  def batch_update
    rows = Array(params.require(:tasks))
    raise Error, l(:error_gantrix_no_selection) if rows.empty?

    moved = []
    Issue.transaction do
      rows.each do |t|
        issue = @project.issues.visible.find_by(id: t[:id])
        raise Error, l(:error_gantrix_not_found) unless issue

        begin
          moved << issue.id if apply_update(issue, t)
        rescue Error => e
          raise Error, "##{issue.id} #{issue.subject}: #{e.message}"
        end
      end
      push_successors(moved) if moved.any?
    end
    render json: { ok: true, updated: rows.size }
  end

  # POST api/tasks/import: { after_id:, parent_id:, rows: [{ level:, subject:, assigned_to:, start_date:, due_date:, estimated_hours: }] }
  # Creates pasted rows; `level` (0 = same level as the insert position) becomes the parent/child structure.
  def import_tasks
    require_permission(:add_issues)
    rows = Array(params.require(:rows))
    tracker = @project.trackers.sorted.first
    raise Error, l(:error_gantrix_no_tracker) unless tracker

    users = @project.assignable_users.to_a
    base_parent = params[:parent_id].presence&.to_i
    created = []
    Issue.transaction do
      stack = [] # stack[level] = issue id of the last row at that level
      after = params[:after_id].presence&.to_i
      rows.each_with_index do |r, n|
        level = [r[:level].to_i, stack.size].min
        parent_id = level.zero? ? base_parent : stack[level - 1]
        issue = Issue.new(project: @project, author: User.current)
        issue.tracker = tracker
        who = users.detect { |u| u.name == r[:assigned_to].to_s.strip || u.login == r[:assigned_to].to_s.strip } if r[:assigned_to].present?
        attrs = { 'subject' => r[:subject].to_s.strip.presence || l(:label_gantrix_new_task), 'parent_issue_id' => parent_id&.to_s,
                  'assigned_to_id' => who&.id&.to_s, 'start_date' => r[:start_date].presence, 'due_date' => r[:due_date].presence,
                  'estimated_hours' => r[:estimated_hours].presence }.compact
        issue.safe_attributes = attrs
        issue.status ||= tracker.default_status
        raise Error, l(:error_gantrix_paste_row, row: n + 1, message: issue.errors.full_messages.join(', ')) unless issue.save

        sibs = ordered_siblings(issue.parent_id) - [issue.id]
        anchor = level.zero? ? after : nil
        idx = anchor ? sibs.index(anchor) : nil
        sibs.insert(idx ? idx + 1 : sibs.size, issue.id)
        Gantrix::Positions.write(sibs)
        after = issue.id if level.zero?
        stack = stack[0, level] + [issue.id]
        created << issue.id
      end
    end
    render json: { ids: created }
  end

  # With redmine_issue_trash the task and its subtasks go to the trash: the answer has what undoing needs
  # (the ids to restore and where their time entries were)
  def destroy_task
    require_permission(:delete_issues)
    raise Error, l(:error_gantrix_cannot_delete) unless @issue.deletable?

    ids = @issue.self_and_descendants.pluck(:id)
    entries = nil
    Issue.transaction do
      entries = keep_time_entries(@issue)
      # each subtask on its own, deepest first: Redmine 5 deletes subtasks with their parent without the trash
      @issue.descendants.reorder(lft: :desc).each(&:destroy) if trash_installed?
      @issue.reload.destroy
    end
    render json: { ok: true, ids: ids, time_entries: entries, trashed: trash_installed? }
  end

  # POST api/tasks/restore: brings tasks back from the trash (undo of a delete, redo of an added task),
  # parents first, with the relations between them and their time entries ({ entry id => issue id })
  def restore_tasks
    require_permission(:add_issues)
    raise Error, l(:error_gantrix_no_trash) unless trash_installed?

    ids = Array(params[:ids]).to_set(&:to_i)
    # the latest copy of each task
    pending = TrashedIssue.where(project_id: @project.id).order(id: :desc).to_a
                          .select { |t| ids.include?(t.attributes_json['id']) }.uniq { |t| t.attributes_json['id'] }
    restored = []
    relations = []
    Issue.transaction do
      until pending.empty?
        # a task whose parent is not waiting in the trash (restored already, never deleted, or gone)
        waiting = pending.to_set { |t| t.attributes_json['id'] }
        ready = pending.reject { |t| waiting.include?(t.attributes_json['parent_id']) }
        raise Error, l(:error_gantrix_cannot_restore) if ready.empty?

        ready.each do |t|
          relations.concat(Array(t.attributes_json['relations']).map { |attrs| IssueRelation.new(attrs) })
          restored << restore_from_trash(t)
        end
        pending -= ready
      end
      # the relations once all tasks are back: a relation between two subtasks is kept only in the trash copy of
      # the one deleted first
      relations.each do |rel|
        next unless Issue.exists?(rel.issue_from_id) && Issue.exists?(rel.issue_to_id)
        next if IssueRelation.exists?(issue_from_id: rel.issue_from_id, issue_to_id: rel.issue_to_id, relation_type: rel.relation_type)

        IssueRelation.new(rel.attributes.except('id')).save
      end
      entries = params[:time_entries].respond_to?(:to_unsafe_h) ? params[:time_entries].to_unsafe_h : params[:time_entries].to_h
      entries.each do |entry_id, issue_id|
        TimeEntry.where(id: entry_id.to_i, project_id: @project.id).update_all(issue_id: issue_id.to_i) # rubocop:disable Rails/SkipsModelValidations
      end
    end
    render json: { ids: restored }
  end

  # the answer has the place before and after the move: undo and redo put the task back with place_task
  def move_task
    sibs = ordered_siblings(@issue.parent_id)
    idx = sibs.index(@issue.id)
    before = { parent_id: @issue.parent_id, index: idx }
    Issue.transaction do
      case params[:direction]
      when 'up', 'down'
        to = idx + (params[:direction] == 'up' ? -1 : 1)
        if to.between?(0, sibs.size - 1)
          sibs[idx], sibs[to] = sibs[to], sibs[idx]
          Gantrix::Positions.write(sibs)
        end
      when 'indent'
        raise Error, l(:error_gantrix_cannot_indent) if idx.zero?

        new_parent = sibs[idx - 1]
        change_parent(new_parent)
        Gantrix::Positions.write(ordered_siblings(new_parent) - [@issue.id] + [@issue.id])
      when 'outdent'
        old_parent = @issue.parent
        raise Error, l(:error_gantrix_top_level) unless old_parent && old_parent.project_id == @project.id

        change_parent(old_parent.parent_id)
        list = ordered_siblings(old_parent.parent_id) - [@issue.id]
        list.insert(list.index(old_parent.id) + 1, @issue.id)
        Gantrix::Positions.write(list)
      else
        raise Error, l(:error_gantrix_invalid_operation)
      end
    end
    @issue.reload
    render json: { ok: true, before: before, after: { parent_id: @issue.parent_id, index: ordered_siblings(@issue.parent_id).index(@issue.id) } }
  end

  # POST api/tasks/:id/place: puts the task under +parent_id+ (blank: top level) at +index+ among its siblings
  def place_task
    parent_id = params[:parent_id].presence&.to_i
    raise Error, l(:error_gantrix_invalid_operation) if parent_id && !@project.issues.exists?(parent_id)

    Issue.transaction do
      change_parent(parent_id) if parent_id != @issue.parent_id
      list = ordered_siblings(parent_id) - [@issue.id]
      list.insert(params[:index].to_i.clamp(0, list.size), @issue.id)
      Gantrix::Positions.write(list)
    end
    render json: { ok: true }
  end

  # リスケ: shift tasks (and optionally all successors) by N working days.
  # POST api/reschedule/preview: the planned dates, nothing is saved
  def reschedule_preview
    scheduler = planned_reschedule
    render json: { changes: scheduler.preview, finish: scheduler.finish }
  end

  def reschedule
    scheduler = planned_reschedule
    changed = nil
    dates = ->(ids) { @project.issues.where(id: ids).pluck(:id, :start_date, :due_date).to_h { |id, s, e| [id, [s, e]] } }
    before = dates.call(@project.issues.select(:id))
    Issue.transaction { changed = scheduler.save!(notes: params[:notes].presence) }
    # parents follow their subtasks: undoing puts back the subtasks only
    after = dates.call(@project.issues.where(id: changed).where(Issue.arel_table[:rgt].eq(Issue.arel_table[:lft] + 1)).select(:id))
    # the dates before and after, for undo and redo
    render json: { changed: changed.size, changes: after.map { |id, to| { id: id, from: before[id], to: to } } }
  end

  # A baseline is only a name and a point in time; its plan is rebuilt from journals.
  # `at` may be in the past ("treat the plan of 9/7 as the original plan").
  def create_baseline
    at = params[:at].present? ? parse_time(params[:at]) : Time.now
    at = Time.now if at > Time.now
    item = Gantrix::Baselines.add(@project, name: params[:name].presence || l(:label_gantrix_baseline_default, date: at.to_date),
                                            at: at, user: User.current)
    render json: { id: item['id'] }
  end

  def destroy_baseline
    raise Error, l(:error_gantrix_not_found) unless Gantrix::Baselines.get(@project, params[:baseline_id])

    Gantrix::Baselines.remove(@project, params[:baseline_id])
    render json: { ok: true }
  end

  private

  def planned_reschedule
    require_permission(:edit_issues)
    project_ids = @project.issues.pluck(:id)
    ids = Array(params[:issue_ids]).map(&:to_i) & project_ids
    days = params[:days].to_i
    raise Error, l(:error_gantrix_no_selection) if ids.empty?
    raise Error, l(:error_gantrix_no_days) if days.zero?

    scheduler = Gantrix::Scheduler.new(@project)
    scheduler.shift(ids, days, with_successors: params[:with_successors].to_s == 'true')
    scheduler.push!(from: ids)
    scheduler
  end

  # Redmine would delete the time entries with the issue; keep the hours (they are the actual
  # cost of EVM) on the project, or on the parent task when time entries must have a task
  # (the same choices as Redmine's own delete screen).
  # returns { entry id => issue id } of the entries moved
  def keep_time_entries(issue)
    ids = issue.self_and_descendants.pluck(:id)
    entries = TimeEntry.where(issue_id: ids)
    moved = entries.pluck(:id, :issue_id).to_h
    return moved if moved.empty?

    if Setting.timelog_required_fields.include?('issue_id')
      raise Error, l(:error_gantrix_time_entries) unless issue.parent && ids.exclude?(issue.parent_id)

      entries.update_all(issue_id: issue.parent_id) # rubocop:disable Rails/SkipsModelValidations
    else
      entries.update_all(issue_id: nil) # rubocop:disable Rails/SkipsModelValidations
    end
    moved
  end

  # saved issue queries (custom queries) the user can use in this project
  def available_queries
    IssueQuery.visible.where(project_id: [nil, @project.id]).order(:name).to_a
  end

  # bookmarked queries first (redmine_query_bookmarks keeps them in the user's preferences;
  # without that plugin the list is simply empty)
  def query_list
    marks = User.current.logged? ? User.current.pref[:bookmarked_query_ids].to_s.split(',').map(&:to_i) : []
    available_queries.sort_by { |q| [marks.index(q.id) || marks.size, q.name] }
                     .map { |q| { id: q.id, name: q.name, bookmarked: marks.include?(q.id) } }
  end

  def find_query
    id = params[:query_id].to_i
    return nil unless id.positive?

    query = available_queries.detect { |q| q.id == id }
    query&.project = @project
    query
  end

  # keeps the issues the query matches, plus their ancestors so the hierarchy stays readable;
  # returns [issues, ids of ancestors shown only as context]
  def filter_by_query(issues, query)
    with_ancestors(issues, query.issue_ids)
  rescue ::Query::StatementInvalid => e
    raise Error, e.message
  end

  # The "in progress" view as a tree: the parents of the tasks in progress are unfolded, and so are +opened+
  # (unfolded on the screen); the tasks shown are the top-level ones and the subtasks of the unfolded tasks.
  def needed_tree(all, tree, opened)
    recent = @project.issues.visible.where(Issue.arel_table[:closed_on].gteq(RECENT_CLOSED_DAYS.days.ago)).pluck(:id).to_set
    old = User.current.today - OLD_OPEN_DAYS
    by_id = all.index_by(&:id)
    unfold = Set.new
    all.each do |i|
      # an open task without dates (just added, not planned yet) is in progress too
      next unless i.closed? ? recent.include?(i.id) : (i.due_date || i.start_date || old) >= old

      parent = i.parent_id
      parent = by_id[parent].parent_id while parent && by_id[parent] && unfold.add?(parent)
    end
    unfold |= opened
    shown = Set.new
    queue = tree.children(nil).dup
    while (id = queue.shift)
      shown << id
      queue.concat(tree.children(id)) if unfold.include?(id)
    end
    all.select { |i| shown.include?(i.id) }
  end

  def with_ancestors(issues, matched_ids)
    by_id = issues.index_by(&:id)
    keep = matched_ids.select { |id| by_id[id] }.to_set
    context = []
    keep.to_a.each do |id|
      parent = by_id[id].parent_id
      while parent && by_id[parent] && keep.exclude?(parent)
        keep << parent
        context << parent
        parent = by_id[parent].parent_id
      end
    end
    [issues.select { |i| keep.include?(i.id) }, context.to_set]
  end

  # Leaf tasks left out of the screen still count in their parents' dates, progress and hours and in
  # the summary. Each parent shown gets the totals of the hidden leaves below it, in the order
  # [start, due, actual start, actual end, all have an actual end, working days, working days x progress,
  # estimated hours, spent hours] (the screen rolls them up with its own leaves); the summary gets the
  # totals of all hidden leaves with both dates.
  def hidden_leaves(all, ids, tree, actuals, spent, calendar)
    by_id = all.index_by(&:id)
    shown_parent = {} # hidden id => the nearest ancestor shown (nil: none)
    nearest = lambda do |id|
      path = []
      cur = by_id.key?(id) ? id : nil
      while cur && ids.exclude?(cur) && !shown_parent.key?(cur)
        path << cur
        cur = by_id[cur].parent_id
        cur = nil unless by_id.key?(cur)
      end
      found = cur && (ids.include?(cur) ? cur : shown_parent[cur])
      path.each { |x| shown_parent[x] = found }
      found
    end
    today = User.current.today
    rollups = {}
    summary = { w: 0, ev: 0.0, pv: 0, late: 0, behind: 0 }
    all.each do |i|
      next if ids.include?(i.id) || !tree.leaf?(i.id)

      w = calendar.working_days(i.start_date, i.due_date)
      done = i.done_ratio.to_i
      if i.start_date && i.due_date
        elapsed = today < i.start_date ? 0 : calendar.working_days(i.start_date, [i.due_date, today].min)
        summary[:w] += w
        summary[:ev] += w * done / 100.0
        summary[:pv] += elapsed
        if done < 100 && i.due_date < today
          summary[:late] += 1
        elsif i.start_date <= today && done < (elapsed.to_f / w * 100).floor
          summary[:behind] += 1
        end
      end
      parent = nearest.call(i.parent_id)
      next unless parent

      actual = actuals[i.id] || {}
      r = (rollups[parent] ||= [nil, nil, nil, nil, true, 0, 0, 0.0, 0.0])
      r[0] = [r[0], i.start_date].compact.min
      r[1] = [r[1], i.due_date].compact.max
      r[2] = [r[2], actual[:start]].compact.min
      r[3] = [r[3], actual[:end]].compact.max
      r[4] &&= actual[:end].present?
      r[5] += w
      r[6] += w * done
      r[7] += i.estimated_hours.to_f
      r[8] += spent[i.id].to_f
    end
    rollups.each_value do |r|
      r[7] = r[7].round(2)
      r[8] = r[8].round(2)
    end
    summary[:ev] = summary[:ev].round(4)
    { rollups: rollups, summary: summary }
  end

  # Applies one row of edits; returns true when dates or predecessors changed.
  def apply_update(issue, t)
    attrs = {}
    %w[subject assigned_to_id start_date due_date done_ratio estimated_hours status_id].each do |k|
      attrs[k] = t[k].to_s if t.key?(k)
    end
    notes = t[:notes].to_s.strip.presence
    raise Error, l(:error_gantrix_no_notes_permission) if notes && !User.current.allowed_to?(:add_issue_notes, @project)

    cf = {}
    { 'actual_start_date' => 'cf_actual_start', 'actual_end_date' => 'cf_actual_end' }.each do |k, key|
      next unless t.key?(k)

      parse_date(t[k])
      cf[Gantrix::Fields.id(key).to_s] = t[k].to_s
    end
    attrs['custom_field_values'] = cf if cf.any?
    reschedule = false
    if attrs.any? || notes
      raise Error, l(:error_gantrix_cannot_edit) if attrs.except('status_id').any? && !issue.attributes_editable?(User.current)

      unsafe = attrs.keys - issue.safe_attribute_names(User.current)
      raise Error, l(:error_gantrix_unsafe_fields, fields: unsafe.join(', ')) if unsafe.any?

      issue.init_journal(User.current, notes)
      issue.safe_attributes = attrs
      # the workflow decides which statuses can be chosen; safe_attributes silently ignores the others
      raise Error, l(:error_gantrix_workflow_status) if attrs.key?('status_id') && issue.status_id.to_s != attrs['status_id']

      cf.each do |id, v|
        next if issue.custom_field_value(CustomField.find(id)).to_s == v

        raise Error, l(:error_gantrix_unsafe_fields, fields: CustomField.find(id).name)
      end
      reschedule = issue.start_date_changed? || issue.due_date_changed?
      raise Error, issue.errors.full_messages.join(', ') unless issue.save
    end
    if t.key?(:predecessors)
      @issue = issue
      update_predecessors(t[:predecessors].to_s)
      reschedule = true
    end
    reschedule
  end

  def push_successors(ids)
    scheduler = Gantrix::Scheduler.new(@project)
    scheduler.push!(from: ids)
    scheduler.save!
  end

  def ensure_fields
    Gantrix::Fields.ensure!
  end

  def trash_installed?
    defined?(TrashedIssue) ? true : false
  end

  # the same as redmine_issue_trash's "restore" (RestoredIssuesController)
  def restore_from_trash(trashed)
    # SQLite reuses the highest id: the issue's may be taken again, and its journals may share ids with
    # those of another issue in the trash. Journals get new ids (nothing refers to them).
    raise Error, l(:error_gantrix_cannot_restore) if Issue.exists?(trashed.attributes_json['id'])

    Array(trashed.attributes_json['journals']).each do |journal|
      journal.delete('id')
      Array(journal['details']).each { |detail| detail.delete('id') }
    end
    issue = trashed.rebuild
    issue.watcher_users = []
    issue.init_journal(User.current, l(:notes_issue_restored))
    raise Error, issue.errors.full_messages.join(', ') unless issue.save

    issue.watcher_users = User.where(id: issue.watcher_user_ids | Array(trashed.attributes_json['watcher_user_ids']))
    trashed.destroy!
    issue.id
  end

  # { issue_id => { start:, end: } } from the actual-date custom fields
  def actual_dates(ids)
    keys = { Gantrix::Fields.id('cf_actual_start') => :start, Gantrix::Fields.id('cf_actual_end') => :end }
    CustomValue.where(customized_type: 'Issue', customized_id: ids, custom_field_id: keys.keys).where.not(value: [nil, ''])
               .pluck(:customized_id, :custom_field_id, :value)
               .each_with_object({}) { |(id, cf, v), h| (h[id] ||= {})[keys[cf]] = v }
  end

  def parse_time(value)
    Time.zone.parse(value.to_s) || raise(ArgumentError)
  rescue ArgumentError
    raise Error, l(:error_gantrix_invalid_date, value: value)
  end

  def find_task
    @issue = @project.issues.visible.find(params[:issue_id])
  rescue ActiveRecord::RecordNotFound
    render json: { error: l(:error_gantrix_not_found) }, status: :not_found
  end

  def permissions
    u = User.current
    {
      edit: u.allowed_to?(:edit_gantrix, @project),
      add_issues: u.allowed_to?(:add_issues, @project),
      edit_issues: u.allowed_to?(:edit_issues, @project),
      delete_issues: u.allowed_to?(:delete_issues, @project),
      manage_relations: u.allowed_to?(:manage_issue_relations, @project),
      manage_subtasks: u.allowed_to?(:manage_subtasks, @project)
    }
  end

  def require_permission(perm)
    raise Error, l(:error_gantrix_no_permission, permission: perm) unless User.current.allowed_to?(perm, @project)
  end

  # Holidays the screen needs: around today and the tasks, within the years that have holidays at all
  # (a due date of 9999-12-31 does not ask for thousands of empty years).
  def holiday_range(issues)
    years = Gantrix::Calendar::JP_YEARS
    dates = issues.flat_map { |i| [i.start_date, i.due_date] }.compact.select { |d| years.cover?(d.year) }
    dates << User.current.today
    [[dates.min - 366, Date.new(years.first, 1, 1)].max, [dates.max + 731, Date.new(years.last, 12, 31)].min]
  end

  def holiday_name(name)
    return name if current_language.to_s.start_with?('ja')
    return l(:label_gantrix_company_holiday) if name == Gantrix::Calendar::COMPANY_HOLIDAY

    Gantrix::Calendar::HOLIDAY_NAMES_EN.fetch(name, name)
  end

  def parse_date(value)
    value.present? ? Date.iso8601(value.to_s) : nil
  rescue ArgumentError
    raise Error, l(:error_gantrix_invalid_date, value: value)
  end

  # Siblings in WBS order: saved position, then start date, then id.
  def ordered_siblings(parent_id)
    rows = @project.issues.where(parent_id: parent_id).pluck(:id, :start_date)
    pos = Gantrix::Positions.for(rows.map(&:first))
    rows.sort_by { |id, start| [pos[id] || (1 << 30), start || Date.new(9999), id] }.map(&:first)
  end

  def change_parent(parent_id)
    require_permission(:manage_subtasks)
    @issue.init_journal(User.current)
    @issue.safe_attributes = { 'parent_issue_id' => parent_id.to_s }
    raise Error, @issue.errors.full_messages.join(', ') unless @issue.save
  end

  def update_predecessors(value)
    require_permission(:manage_issue_relations)
    project_ids = @project.issues.pluck(:id)
    wanted = value.scan(/\d+/).map(&:to_i).uniq & project_ids
    wanted -= [@issue.id]
    existing = IssueRelation.where(issue_to_id: @issue.id, relation_type: IssueRelation::TYPE_PRECEDES).to_a
    existing.each do |r|
      next if wanted.include?(r.issue_from_id)

      r.init_journals(User.current)
      r.destroy
    end
    (wanted - existing.map(&:issue_from_id)).each do |from_id|
      r = IssueRelation.new(issue_from: Issue.find(from_id), issue_to: @issue,
                            relation_type: IssueRelation::TYPE_PRECEDES)
      r.init_journals(User.current)
      raise Error, l(:error_gantrix_predecessor, id: from_id, message: r.errors.full_messages.join(', ')) unless r.save
    end
  end
end
