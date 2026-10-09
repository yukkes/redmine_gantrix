# frozen_string_literal: true

# In-memory rescheduler for one project's issues.
#
#   s = Gantrix::Scheduler.new(project)
#   s.shift([12], 3, with_successors: true)  # リスケ: +3 working days
#   s.push!                                  # enforce "precedes" relations
#   s.save!(notes: '仕様変更のため')
#
# Dates are planned in memory first and then saved in start-date order, each
# issue reloaded right before saving because Redmine's own
# reschedule_following_issues callback may have touched it in the meantime.
class Gantrix::Scheduler
  class Error < StandardError; end

  attr_reader :calendar

  def initialize(project, calendar = Gantrix::Calendar.from_settings)
    @project = project
    @calendar = calendar
    @issues = project.issues.to_a.index_by(&:id)
    @children = Hash.new { |h, k| h[k] = [] }
    @issues.each_value { |i| @children[i.parent_id] << i.id if @issues.key?(i.parent_id) }
    @relations = IssueRelation.where(relation_type: IssueRelation::TYPE_PRECEDES,
                                     issue_from_id: @issues.keys, issue_to_id: @issues.keys).to_a
    @dates = @issues.transform_values { |i| [i.start_date, i.due_date] }
    @original = @dates.dup
    @derived = Setting.parent_issue_dates == 'derived'
  end

  def leaves(id)
    kids = @children.fetch(id, [])
    kids.empty? ? [id] : kids.flat_map { |k| leaves(k) }
  end

  def ancestors(id)
    list = []
    while (pid = @issues[id]&.parent_id) && @issues.key?(pid)
      list << pid
      id = pid
    end
    list
  end

  # Effective [start, due] (parents derive from their children).
  def effective(id)
    kids = @children.fetch(id, [])
    return @dates[id] if kids.empty? || !@derived

    pairs = kids.map { |k| effective(k) }
    [pairs.filter_map(&:first).min, pairs.filter_map(&:last).max]
  end

  # Every issue reachable through "precedes" relations from +ids+ (including
  # relations on their ancestors and the subtrees of successors).
  def downstream(ids)
    seen = {}
    queue = ids.dup
    until queue.empty?
      id = queue.shift
      next if seen[id]

      seen[id] = true
      sources = [id] + ancestors(id)
      @relations.each do |r|
        next unless sources.include?(r.issue_from_id)

        queue.concat(subtree(r.issue_to_id))
      end
    end
    seen.keys - ids
  end

  def subtree(id)
    [id] + @children.fetch(id, []).flat_map { |k| subtree(k) }
  end

  # Shift the leaves under +ids+ by +days+ working days (negative = earlier).
  def shift(ids, days, with_successors: false)
    targets = ids.flat_map { |i| subtree(i) }
    targets += downstream(targets) if with_successors
    targets.uniq.flat_map { |i| leaves(i) }.uniq.each do |leaf|
      start, due = @dates[leaf]
      next unless start

      @dates[leaf] = @calendar.shift_task(start, due, @calendar.add_working_days(start, days))
    end
  end

  def set_dates(id, start, due)
    @dates[id] = [start, due]
  end

  # Push successors later until every "precedes" relation holds. With
  # +from+, only issues downstream of those ids are touched.
  def push!(from: nil)
    scope = from && downstream(from.flat_map { |i| subtree(i) }).to_set
    (@issues.size + 1).times do
      moved = false
      @relations.each do |r|
        next if scope&.exclude?(r.issue_to_id)

        pstart, pdue = effective(r.issue_from_id)
        base = pdue || pstart
        next unless base

        soonest = @calendar.step(base, 1 + r.delay.to_i)
        leaves(r.issue_to_id).each do |leaf|
          start, due = @dates[leaf]
          next if start.nil? || start >= soonest

          @dates[leaf] = @calendar.shift_task(start, due, soonest)
          moved = true
        end
      end
      return self unless moved
    end
    raise Error, ::I18n.t(:error_gantrix_cycle)
  end

  # [{ id:, from: [start, due], to: [start, due] }] for the leaves that would move
  def preview
    changes.sort_by { |id| [@dates[id][0] || Date.new(9999), id] }
           .map { |id| { id: id, from: @original[id], to: @dates[id] } }
  end

  # end of the project: { from: before, to: after }
  def finish
    { from: @original.values.filter_map(&:last).max, to: @dates.values.filter_map(&:last).max }
  end

  def changes
    @dates.keys.select { |id| @dates[id] != @original[id] && leaves(id) == [id] }
  end

  # Save the planned dates. Redmine itself then snaps followers to their
  # soonest start using weekends only, so settle again with our calendar
  # (holidays) until nothing moves.
  def save!(notes: nil)
    ids = save_planned(notes)
    touched = ids
    10.times do
      break if touched.empty?

      fresh = self.class.new(@project, @calendar)
      fresh.push!(from: touched)
      touched = fresh.save_planned(notes)
      ids |= touched
    end
    ids
  end

  def save_planned(notes)
    ids = changes.sort_by { |id| [@dates[id][0] || Date.new(9999), id] }
    ids.each do |id|
      issue = Issue.find(id)
      start, due = @dates[id]
      next if issue.start_date == start && issue.due_date == due

      raise Error, ::I18n.t(:error_gantrix_cannot_edit_issue, id: id) unless issue.attributes_editable?(User.current)

      issue.init_journal(User.current, notes)
      issue.safe_attributes = { 'start_date' => start&.iso8601, 'due_date' => due&.iso8601 }
      raise Error, ::I18n.t(:error_gantrix_workflow_dates, id: id) if issue.start_date != start || issue.due_date != due
      raise Error, "##{id}: #{issue.errors.full_messages.join(', ')}" unless issue.save
    end
    ids
  end
end
