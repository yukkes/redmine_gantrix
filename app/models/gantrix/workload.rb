# frozen_string_literal: true

# 担当者の負荷 across projects: estimated hours of open leaf tasks spread evenly over their
# working days, summed per assignee and week (Monday to Sunday), against hours per day.
class Gantrix::Workload
  def initialize(projects, from:, weeks: 12, calendar: Gantrix::Calendar.from_settings)
    @projects = projects
    @from = from - ((from.wday + 6) % 7)
    @weeks = weeks
    @calendar = calendar
  end

  def call
    to = @from + (@weeks * 7) - 1
    weeks = Array.new(@weeks) { |i| @from + (i * 7) }
    hpd = Gantrix::Preferences.hours_per_day
    capacity = weeks.map { |w| @calendar.working_days(w, w + 6) * hpd }
    issues = Issue.visible.open.where(project_id: @projects.map(&:id))
                  .where('start_date <= ? AND due_date >= ?', to, @from).where.not(estimated_hours: nil)
                  .includes(:assigned_to, :project).to_a
    parents = Issue.where(parent_id: issues.map(&:id)).distinct.pluck(:parent_id).to_set
    people = {}
    tasks = {}
    issues.each do |i|
      next if parents.include?(i.id) || !i.estimated_hours.to_f.positive?

      per = i.estimated_hours.to_f / @calendar.working_days(i.start_date, i.due_date)
      key = i.assigned_to_id || 0
      person = people[key] ||= { id: i.assigned_to_id, name: i.assigned_to&.name, cells: Array.new(@weeks) { { hours: 0.0, tasks: [] } }, projects: {} }
      proj = person[:projects][i.project_id] ||= { id: i.project_id, name: i.project.name, hours: Array.new(@weeks, 0.0) }
      weeks.each_with_index do |w, n|
        days = ([i.start_date, w].max..[i.due_date, w + 6].min).count { |d| @calendar.working_day?(d) }
        next if days.zero?

        h = per * days
        person[:cells][n][:hours] += h
        person[:cells][n][:tasks] << i.id
        proj[:hours][n] += h
      end
      tasks[i.id] = { id: i.id, subject: i.subject, project: i.project.name, project_identifier: i.project.identifier,
                      start_date: i.start_date, due_date: i.due_date, estimated_hours: i.estimated_hours.to_f.round(1),
                      per_day: per.round(2) }
    end
    rows = people.values.map do |p|
      p[:cells].each { |c| c[:hours] = c[:hours].round(1) }
      p.merge(projects: p[:projects].values.map { |x| x.merge(hours: x[:hours].map { |h| h.round(1) }) }.sort_by { |x| -x[:hours].sum })
    end
    unassigned = rows.find { |r| r[:id].nil? }
    rows = rows.reject { |r| r[:id].nil? }.sort_by { |r| [-r[:cells].sum { |c| c[:hours] }, r[:name].to_s] }
    { weeks: weeks, capacity: capacity, rows: rows, unassigned: unassigned, tasks: tasks, hours_per_day: hpd }
  end
end
