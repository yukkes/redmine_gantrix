# frozen_string_literal: true

# 全体レポート: one row per project: signal, period, progress, SPI trend, CPI, overdue tasks
# and the next milestone with a forecast. Built on Gantrix::Evm, cached per project until a
# journal or a time entry changes.
class Gantrix::Portfolio
  TREND_POINTS = 8

  def initialize(projects, calendar: Gantrix::Calendar.from_settings, today: User.current.today)
    @projects = projects
    @calendar = calendar
    @today = today
  end

  def self.thresholds
    s = Setting.plugin_redmine_gantrix
    { red: (s['signal_red'].presence || 0.85).to_f, amber: (s['signal_amber'].presence || 0.95).to_f,
      overdue: (s['signal_overdue'].presence || 3).to_i }
  end

  def rows
    stamp = [Journal.maximum(:id).to_i, TimeEntry.maximum(:updated_on).to_i, Issue.maximum(:updated_on).to_i, @today]
    @projects.map do |p|
      Rails.cache.fetch(['gantrix_portfolio', p.id, p.updated_on.to_i, *stamp], expires_in: 6.hours) { row(p) }
    end
  end

  def row(project)
    baseline = Gantrix::Baselines.list(project).max_by { |b| b['at'].to_s }
    evm = Gantrix::Evm.new(project, calendar: @calendar, baseline: baseline).call
    now = evm[:now] || {}
    past = evm[:series].select { |pt| pt[:ev] && pt[:pv].to_f.positive? }
    trend = past.last(TREND_POINTS).map { |pt| (pt[:ev] / pt[:pv]).round(2) }
    overdue = project.issues.open.where('due_date < ?', @today).count
    {
      id: project.id, identifier: project.identifier, name: project.name, parent: project.parent&.name,
      managers: managers(project), start: evm[:start], finish: evm[:finish], forecast: now[:forecast],
      progress: now[:progress], planned_progress: now[:planned_progress], spi: now[:spi], cpi: now[:cpi],
      trend: trend, overdue: overdue, milestone: next_milestone(project), unit: evm[:unit],
      signal: signal(now[:spi], now[:cpi], overdue), has_plan: evm[:series].any?
    }
  end

  def signal(spi, cpi, overdue)
    t = self.class.thresholds
    values = [spi, cpi].compact
    return 'red' if values.any? { |v| v < t[:red] } || overdue >= t[:overdue]
    return 'amber' if values.any? { |v| v < t[:amber] } || overdue.positive?

    'green'
  end

  private

  # members of the roles chosen as "PM" in the settings (default: roles that can manage members)
  def managers(project)
    ids = Array(Setting.plugin_redmine_gantrix['pm_role_ids']).map(&:to_i).reject(&:zero?)
    roles = ids.any? ? Role.where(id: ids).to_a : Role.givable.select { |r| r.allowed_to?(:manage_members) }
    project.members.includes(:user, :roles).select { |m| m.user && (m.roles & roles).any? }.map { |m| m.user.name }.first(2)
  end

  # next open version with a due date; late when its open tasks end after that date
  def next_milestone(project)
    v = project.shared_versions.open.where('effective_date >= ?', @today).order(:effective_date).first
    return nil unless v

    last_due = v.fixed_issues.open.maximum(:due_date)
    late = last_due && last_due > v.effective_date ? @calendar.working_days(v.effective_date, last_due) - 1 : 0
    left = @calendar.working_days(@today, v.effective_date) - (@calendar.working_day?(@today) ? 1 : 0)
    { name: v.name, date: v.effective_date, days_left: left, late_days: late }
  end
end
