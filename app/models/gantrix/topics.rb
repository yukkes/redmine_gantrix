# frozen_string_literal: true

# "今日のトピック" of a project: open leaf tasks that need attention today.
class Gantrix::Topics
  KINDS = %w[overdue behind not_started unassigned no_estimate].freeze
  SOON = 14 # days ahead for "no assignee" / "no estimate"

  def initialize(project, calendar: Gantrix::Calendar.from_settings, today: User.current.today)
    @project = project
    @calendar = calendar
    @today = today
  end

  def call
    @rows = Gantrix::IssueRows.new(@project.issues.visible)
    issues = @rows.to_a
    tree = Gantrix::Tree.new(issues)
    open = issues.select { |i| tree.leaf?(i.id) && !i.closed? }
    actual = Gantrix::Fields.id('cf_actual_start')
    started = CustomValue.where(custom_field_id: actual, customized_type: 'Issue', customized_id: open.map(&:id))
                         .where.not(value: [nil, '']).pluck(:customized_id).to_set
    topics = KINDS.to_h { |k| [k, []] }
    cards = {}
    open.each do |i|
      planned = planned_ratio(i)
      kinds = []
      kinds << 'overdue' if i.due_date && i.due_date < @today
      kinds << 'behind' if kinds.exclude?('overdue') && planned && i.done_ratio.to_i < planned
      kinds << 'not_started' if i.start_date && i.start_date <= @today && i.done_ratio.to_i.zero? && started.exclude?(i.id)
      soon = i.start_date.nil? || i.start_date <= @today + SOON
      kinds << 'unassigned' if i.assigned_to_id.nil? && soon
      kinds << 'no_estimate' if i.estimated_hours.nil? && soon
      next if kinds.empty?

      kinds.each { |k| topics[k] << i.id }
      cards[i.id] = card(i, tree, planned)
    end
    topics.each_value { |ids| ids.sort_by! { |id| [cards[id][:due_date] || Date.new(9999), id] } }
    { today: @today, topics: topics, cards: cards, load: week_load(open), milestones: milestones }
  end

  # percent of the planned working days that have passed (nil before the start)
  def planned_ratio(issue)
    return nil unless issue.start_date && issue.due_date && issue.start_date <= @today

    total = @calendar.working_days(issue.start_date, issue.due_date)
    done = @calendar.working_days(issue.start_date, [@today, issue.due_date].min)
    (done * 100 / total.to_f).floor
  end

  private

  def card(issue, tree, planned)
    {
      id: issue.id, wbs: tree.wbs(issue.id), subject: issue.subject, status_id: issue.status_id,
      status: @rows.status_names[issue.status_id], assigned_to_id: issue.assigned_to_id,
      assigned_to: @rows.assignee_names[issue.assigned_to_id], start_date: issue.start_date,
      due_date: issue.due_date, done_ratio: issue.done_ratio.to_i, planned: planned, estimated_hours: issue.estimated_hours
    }
  end

  # this week (Monday to Sunday): estimated hours of open tasks per assignee, against capacity
  def week_load(open)
    from = @today - ((@today.wday + 6) % 7)
    to = from + 6
    hpd = Gantrix::Preferences.hours_per_day
    cap = @calendar.working_days(from, to) * hpd
    hours = Hash.new(0.0)
    names = {}
    open.each do |i|
      next unless i.assigned_to_id && i.estimated_hours.to_f.positive? && i.start_date && i.due_date

      per = i.estimated_hours.to_f / @calendar.working_days(i.start_date, i.due_date)
      days = ([i.start_date, from].max..[i.due_date, to].min).count { |d| @calendar.working_day?(d) }
      next if days.zero?

      hours[i.assigned_to_id] += per * days
      names[i.assigned_to_id] = @rows.assignee_names[i.assigned_to_id]
    end
    hours.map { |id, h| { id: id, name: names[id], hours: h.round(1), capacity: cap } }.sort_by { |x| -x[:hours] }
  end

  def milestones
    @project.shared_versions.open.where('effective_date >= ?', @today).order(:effective_date).limit(4)
            .map { |v| { id: v.id, name: v.name, date: v.effective_date } }
  end
end
