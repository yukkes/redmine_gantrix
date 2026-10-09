# frozen_string_literal: true

# Gantrix::Evm computes planned value with one sweep and earned value with one pass over the journals;
# check both against the plain definitions (every task for every date, a snapshot per date):
#   bin/rails runner /seed/checks/evm.rb [project identifier]
require_relative '../runner_setup'

project = Project.find_by(identifier: ARGV[0] || 'demo')
User.current = User.find_by(login: 'admin')
cal = Gantrix::Calendar.from_settings
evm = Gantrix::Evm.new(project, calendar: cal)
issues = Gantrix::IssueRows.new(project.issues).to_a
parents = issues.filter_map(&:parent_id).to_set
plan = issues.reject { |i| parents.include?(i.id) || i.start_date.nil? || i.due_date.nil? }
             .to_h { |i| [i.id, { s: i.start_date, e: i.due_date, budget: i.estimated_hours.to_f.nonzero? || 1.0 }] }
first, last = Gantrix::Period.focus(plan.values.flat_map { |v| [v[:s], v[:e]] }, User.current.today, max_span: nil)
plan.reject! { |_, v| v[:s] < first || v[:e] > last }
dates = (0..12).map { |n| first + ((last - first) * n / 12) } + [User.current.today]
bad = []

# planned value: the budget times the share of the task's working days passed
fast = evm.send(:pv_series, plan, dates)
dates.each do |d|
  want = plan.values.sum do |v|
    a = cal.working_days_through(v[:s] - 1)
    b = cal.working_days_through(v[:e])
    share = if b > a then (cal.working_days_through(d) - a).clamp(0, b - a).fdiv(b - a)
            elsif d >= v[:s] then 1
            else 0
            end
    v[:budget] * share
  end
  bad << "pv #{d}: #{fast[d].round(3)} / #{want.round(3)}" if (fast[d] - want).abs > 1e-6 * [want, 1].max
end

# earned value: the progress each task had at that time, from a snapshot per date
past = dates.select { |d| d <= User.current.today }
fast = evm.send(:ev_series, plan, past)
past.each do |d|
  at = d >= User.current.today ? Time.current : (d + 1).in_time_zone.beginning_of_day
  snap = Gantrix::History.build(project, at)
  want = plan.sum { |id, v| v[:budget] * snap.dig(id, 'done_ratio').to_i / 100.0 }
  bad << "ev #{d}: #{fast[d].round(3)} / #{want.round(3)}" if (fast[d] - want).abs > 1e-6 * [want, 1].max
end
puts bad.first(10)
puts bad.empty? ? "EVM CHECKS OK (#{dates.size + past.size}, #{plan.size} tasks)" : "EVM CHECKS FAILED: #{bad.size}"
