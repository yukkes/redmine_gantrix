# frozen_string_literal: true

# 1,000 tasks for performance checks: bin/rails runner /seed/checks/perf_seed.rb
require_relative '../runner_setup'
User.current = User.find_by(login: 'admin')
project = Project.find_by(identifier: 'perf') ||
          Project.create!(name: '性能確認（1000件）', identifier: 'perf', is_public: true, trackers: Tracker.all,
                          enabled_module_names: Redmine::AccessControl.available_project_modules.map(&:to_s))
exit if project.issues.count >= 1000

cal = Gantrix::Calendar.from_settings
tracker = project.trackers.first
start = cal.next_working_day(Date.today - 30)
Issue.transaction do
  50.times do |p|
    parent = Issue.create!(project: project, tracker: tracker, author: User.current, status: tracker.default_status, subject: "工程 #{p + 1}")
    prev = nil
    19.times do |c|
      s = cal.step(start, (p * 3) + c)
      i = Issue.create!(project: project, tracker: tracker, author: User.current, status: tracker.default_status,
                        subject: "作業 #{p + 1}-#{c + 1}", parent_issue_id: parent.id, start_date: s, due_date: cal.step(s, 2),
                        done_ratio: [0, 20, 50, 100].sample, estimated_hours: 16)
      IssueRelation.create!(issue_from: prev, issue_to: i, relation_type: 'precedes') if prev && c.even?
      prev = i
    end
  end
end
puts "perf project: #{project.issues.count} issues"
