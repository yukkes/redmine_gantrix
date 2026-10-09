# frozen_string_literal: true

# Server-side checks of the scheduling features: bin/rails runner /seed/checks/scheduling.rb
# critical path floats, reschedule preview (no save), time entries kept on delete,
# successor notification mail, relations restored with an issue from the trash.
require_relative '../runner_setup'
ok = true
check = lambda { |name, cond, detail = ''|
  puts "#{cond ? 'ok  ' : 'FAIL'} #{name}#{": #{detail}" unless detail.to_s.empty?}"
  ok &&= cond
}

User.current = admin = User.find_by(login: 'admin')
cal = Gantrix::Calendar.from_settings
project = Project.find_by(identifier: 'schedcheck')
project&.destroy
project = Project.create!(name: 'scheduling check', identifier: 'schedcheck', is_public: false, trackers: Tracker.all,
                          enabled_module_names: Redmine::AccessControl.available_project_modules.map(&:to_s))
tracker = project.trackers.first
suzuki = User.find_by(login: 'suzuki')
Member.create!(project: project, principal: suzuki, roles: [Role.givable.sorted.detect { |r| r.permissions.include?(:edit_issues) }])
d0 = cal.next_working_day(Date.today)
mk = lambda do |subject, start, days, who = nil|
  Issue.create!(project: project, tracker: tracker, author: admin, status: tracker.default_status, subject: subject,
                start_date: start, due_date: cal.step(start, days - 1), assigned_to: who, estimated_hours: days * 8)
end
# a (5d) -> b (5d) -> d ; c (3d) -> d : c has float 2 (it can slip while b runs)
a = mk.call('A', d0, 5)
b = mk.call('B', cal.step(a.due_date, 1), 5)
c = mk.call('C', cal.step(a.due_date, 1), 3)
d = mk.call('D', cal.step(b.due_date, 1), 2, suzuki)
[[a, b], [b, d], [c, d]].each { |x, y| IssueRelation.create!(issue_from: x, issue_to: y, relation_type: 'precedes') }
issues = project.issues.reload.to_a
rels = IssueRelation.where(issue_from_id: issues.map(&:id))
f = Gantrix::CriticalPath.new(issues, rels, cal).floats
check.call('critical path: A, B, D have no float', [a, b, d].all? { |i| f[i.id].zero? }, f.inspect)
check.call('critical path: C has 2 working days of float', f[c.id] == 2, f[c.id])

# reschedule preview does not save
s = Gantrix::Scheduler.new(project)
s.shift([a.id], 3)
s.push!(from: [a.id])
pv = s.preview
check.call('preview lists A and its successors (not C)', pv.pluck(:id).sort == [a.id, b.id, d.id].sort, pv.pluck(:id).inspect)
check.call('preview saves nothing', a.reload.start_date == d0)
check.call('preview: project end moves 3 working days', s.finish[:to] == cal.step(s.finish[:from], 3), s.finish.inspect)

# successor notification
ActionMailer::Base.delivery_method = :test
ActionMailer::Base.perform_deliveries = true
ActionMailer::Base.deliveries.clear
ActiveJob::Base.queue_adapter = :inline
suzuki.update!(mail_notification: 'only_my_events')
User.current = admin
b.reload.init_journal(admin)
b.update!(done_ratio: 100)
check.call('no mail while another predecessor (C) is not done', ActionMailer::Base.deliveries.empty?, ActionMailer::Base.deliveries.map(&:subject).inspect)
c.reload.init_journal(admin)
c.update!(status: IssueStatus.where(is_closed: true).first)
mails = ActionMailer::Base.deliveries
check.call('mail to the successor assignee when all predecessors are done', mails.size == 1 && mails.first.to == [suzuki.mail], mails.map do |m|
  [m.to, m.subject]
end.inspect)
check.call('the mail is in the assignee language', mails.first&.subject.to_s.include?('開始できます'), mails.first&.subject)

# deleting keeps the time entries on the project
TimeEntry.create!(project: project, issue: a, user: admin, hours: 3, spent_on: Date.today, activity: TimeEntryActivity.first)
before = TimeEntry.where(project_id: project.id).sum(:hours)
GantrixController.new.send(:keep_time_entries, a.reload)
a.reload.destroy
check.call('time entries stay on the project after delete',
           TimeEntry.where(project_id: project.id).sum(:hours) == before && TimeEntry.where(project_id: project.id, issue_id: nil).sum(:hours) == 3)

# trash restore brings relations back
if defined?(TrashedIssue)
  dd = Issue.find(d.id)
  dd.destroy
  t = TrashedIssue.where(project_id: project.id).order(:id).last
  restored = t.rebuild
  restored.watcher_users = []
  restored.init_journal(admin, 'restore')
  ActiveRecord::Base.transaction do
    restored.save!
    t.destroy!
  end
  back = IssueRelation.where(issue_to_id: d.id, relation_type: 'precedes').pluck(:issue_from_id).sort
  check.call('relations come back when an issue is restored from the trash', back == [b.id, c.id].sort, back.inspect)
else
  puts 'skip trash: redmine_issue_trash not installed'
end
# baselines live in the plugin settings, not in a project custom field (shown to admins on the overview)
Gantrix::Baselines.add(project, name: 'check', at: Time.now, user: admin)
check.call('baselines are kept in the settings', Gantrix::Baselines.list(project).pluck('name') == ['check'])
check.call('no project custom field holds baselines', ProjectCustomField.where('name LIKE ?', '%基準計画%').none?)

# SQLite's "database is locked" during the holiday refresh schedules a retry (it arrives as StatementInvalid)
busy = Module.new do
  def fetch_cao!
    raise SQLite3::BusyException, 'database is locked'
  rescue SQLite3::BusyException => e
    raise ActiveRecord::StatementInvalid, e.message
  end
end
if defined?(SQLite3::BusyException)
  adapter = ActiveJob::Base.queue_adapter
  Gantrix::HolidaySource.singleton_class.prepend(busy)
  ActiveJob::Base.queue_adapter = :test
  Gantrix::HolidayJob.perform_now
  jobs = ActiveJob::Base.queue_adapter.enqueued_jobs
  check.call('holiday refresh retries when SQLite is busy', jobs.size == 1 && jobs.first[:job] == Gantrix::HolidayJob)
  ActiveJob::Base.queue_adapter = adapter
end

project.destroy
puts ok ? 'SCHEDULING CHECKS OK' : 'SCHEDULING CHECKS FAILED'
