# frozen_string_literal: true

# Demo data: bin/rails runner /seed/seed_demo.rb
# In English (for the English screenshots): docker compose exec -e DEMO_LANG=en <service> bin/rails runner ...
# The tests expect the Japanese data (the default).
require_relative 'runner_setup'
DEMO_LANG = ENV['DEMO_LANG'] == 'en' ? 'en' : 'ja'
TEXT = {
  'ja' => {
    project: 'ナビシステム開発（デモ）', project2: '店舗アプリ改修（デモ）',
    users: [%w[tanaka 田中 一郎], %w[suzuki 鈴木 花子], %w[sato 佐藤 健]],
    tasks: %w[要件定義 現行業務ヒアリング 要件定義書作成 要件レビュー 基本設計 画面設計 DB設計 基本設計レビュー
              詳細設計・製造 詳細設計 製造 単体テスト 結合テスト リリース判定],
    versions: %w[基本設計完了 詳細設計完了 製造完了], baseline: '当初計画',
    queries: %w[鈴木さんの担当 未完了のタスク],
    tasks2: ['画面改修', 'API 改修', '結合テスト', 'リリース']
  },
  'en' => {
    project: 'Navigation System (demo)', project2: 'Store App Update (demo)',
    users: [%w[tanaka Tanaka Ichiro], %w[suzuki Suzuki Hanako], %w[sato Sato Ken]],
    tasks: ['Requirements', 'Current process interviews', 'Requirements document', 'Requirements review',
            'Basic design', 'Screen design', 'Database design', 'Basic design review', 'Detailed design and build',
            'Detailed design', 'Build', 'Unit testing', 'Integration testing', 'Release decision'],
    versions: ['Basic design done', 'Detailed design done', 'Build done'], baseline: 'Original plan',
    queries: ["Suzuki's tasks", 'Open tasks'],
    tasks2: ['Screen changes', 'API changes', 'Integration testing', 'Release']
  }
}[DEMO_LANG]
Setting.default_language = DEMO_LANG
Redmine::DefaultData::Loader.load(DEMO_LANG) unless Tracker.exists?
Setting.non_working_week_days = %w[6 7]
theme = Redmine::Themes.themes.detect { |t| t.id == 'gantrix' }
Setting.ui_theme = theme.id if theme
Setting.user_format = DEMO_LANG == 'ja' ? 'lastname_firstname' : 'firstname_lastname'
Setting.notified_events = []
ActionMailer::Base.perform_deliveries = false
admin = User.find_by(login: 'admin')
admin.update!(must_change_passwd: false, language: DEMO_LANG)
User.current = admin

exit if Project.exists?(identifier: 'demo')

role = Role.givable.sorted.detect { |r| r.permissions.include?(:edit_issues) } || Role.givable.first
role.add_permission!(:view_gantrix, :edit_gantrix, :view_gantrix_report, :view_gantrix_dashboard, :view_gantrix_kanban)
project = Project.create!(name: TEXT[:project], identifier: 'demo', is_public: true,
                          trackers: Tracker.all,
                          # news and documents are left out so that the tabs fit in 1280px
                          enabled_module_names: Redmine::AccessControl.available_project_modules.map(&:to_s) - %w[news documents])
users = TEXT[:users].map do |login, last, first|
  u = User.find_by(login: login) || User.create!(login: login, firstname: first, lastname: last,
                                                 mail: "#{login}@example.com", password: 'password123',
                                                 language: DEMO_LANG)
  Member.create!(project: project, principal: u, roles: [role])
  u
end

# holidays first: otherwise the scheduler below moves tasks off them, with a journal dated now
begin
  Gantrix::HolidaySource.fetch_cao! if Gantrix::HolidaySource.stale?
rescue Gantrix::HolidaySource::Error => e
  puts "holidays not fetched: #{e.message}"
end
cal = Gantrix::Calendar.from_settings
today = Date.today
start = cal.step(cal.next_working_day(today), -18)
tracker = project.trackers.first
fields = Gantrix::Fields.ensure!
statuses = IssueStatus.sorted.to_a
st_doing = statuses.detect { |x| !x.is_closed? && x != tracker.default_status } || tracker.default_status
st_done = statuses.detect(&:is_closed?) || tracker.default_status
mk = lambda do |subject, parent: nil, days: nil, after: [], who: nil, done: 0|
  s = if after.empty?
        parent ? parent.start_date || start : start
      else
        cal.step(after.map(&:due_date).max, 1)
      end
  i = Issue.new(project: project, tracker: tracker, author: admin, subject: subject,
                status: tracker.default_status, parent_issue_id: parent&.id, assigned_to: who,
                start_date: (cal.next_working_day(s) if days),
                due_date: (cal.step(cal.next_working_day(s), days - 1) if days),
                estimated_hours: (days * 8 if days), done_ratio: 0)
  i.save!
  i.update_columns(created_on: (start - 14).to_time) # demo: issues existed before the baseline dates
  # progress is entered as it would be in use: half way through, then at the end (or yesterday),
  # with journals dated on those days so EVM can rebuild the history
  if done.positive? && days
    last = [i.due_date, today - 1].min
    steps = [[i.start_date + ((last - i.start_date) / 2), (done / 2.0 / 10).round * 10], [last, done]].uniq { |d, _| d }
    steps.each do |day, ratio|
      i.reload.init_journal(admin)
      i.done_ratio = ratio
      i.status = ratio == 100 ? st_done : st_doing
      i.custom_field_values = { fields['cf_actual_start'].to_s => i.start_date.to_s,
                                fields['cf_actual_end'].to_s => (ratio == 100 ? last.to_s : '') }
      i.save!
      i.journals.order(:id).last&.update_columns(created_on: day.in_time_zone.change(hour: 18))
    end
  end
  planned = [i.start_date, i.due_date]
  after.each { |p| IssueRelation.create!(issue_from: p, issue_to: i, relation_type: 'precedes') }
  # Redmine moves a successor to the day after its predecessor, holidays unknown to it: put the dates back
  # (without a journal; the scheduler below would otherwise move it again with a journal dated now)
  i.reload
  i.update!(start_date: planned[0], due_date: planned[1]) if [i.start_date, i.due_date] != planned
  # logged time: about 115% of the earned hours, spread over the working days so far
  if done.positive? && i.estimated_hours && (activity = TimeEntryActivity.active.first)
    worked = (i.start_date..[i.due_date, today - 1].min).select { |d| cal.working_day?(d) }
    per = (i.estimated_hours * done / 100.0 * 1.15 / [worked.size, 1].max).round(2)
    worked.each { |d| TimeEntry.create!(project: project, issue: i, user: who || admin, hours: per, spent_on: d, activity: activity) }
  end
  i.reload
end

t, s, k = users
ms = lambda do |name, date|
  Version.create!(project: project, name: name, effective_date: date, status: 'open')
end
n = TEXT[:tasks]
req = mk.call(n[0])
a = mk.call(n[1], parent: req, days: 5, who: t, done: 100)
b = mk.call(n[2], parent: req, days: 6, after: [a], who: t, done: 100)
c = mk.call(n[3], parent: req, days: 2, after: [b], who: s, done: 60)
bd = mk.call(n[4])
d1 = mk.call(n[5], parent: bd, days: 8, after: [c], who: s, done: 10)
d2 = mk.call(n[6], parent: bd, days: 6, after: [c], who: k)
d3 = mk.call(n[7], parent: bd, days: 2, after: [d1, d2], who: t)
dev = mk.call(n[8])
e1 = mk.call(n[9], parent: dev, days: 10, after: [d3], who: s)
e2 = mk.call(n[10], parent: dev, days: 15, after: [e1], who: k)
e3 = mk.call(n[11], parent: dev, days: 8, after: [e2], who: k)
integration = mk.call(n[12], days: 10, after: [e3], who: t)
mk.call(n[13], days: 1, after: [integration], who: t)

v1 = ms.call(TEXT[:versions][0], cal.step(d3.reload.due_date, 1))
ms.call(TEXT[:versions][1], cal.step(e1.reload.due_date, 1))
v3 = ms.call(TEXT[:versions][2], cal.step(e3.reload.due_date, 1))
[[bd, v1], [dev, v3]].each do |parent, v|
  parent.reload.descendants.each { |x| x.update_columns(fixed_version_id: v.id) }
end
Gantrix::Scheduler.new(project).tap(&:push!).save!
Gantrix::Baselines.add(project, name: TEXT[:baseline], at: Time.now, user: admin)
# saved issue queries to try the filter of the schedule
[[TEXT[:queries][0], { 'assigned_to_id' => { operator: '=', values: [users[1].id.to_s] } }],
 [TEXT[:queries][1], { 'status_id' => { operator: 'o', values: [''] } }]].each do |name, filters|
  IssueQuery.create!(name: name, project: project, user: admin, visibility: Query::VISIBILITY_PUBLIC, filters: filters)
end
# bookmarked by admin (the format of redmine_query_bookmarks: ids joined by commas in the preferences)
admin.pref[:bookmarked_query_ids] = IssueQuery.find_by(name: TEXT[:queries][1], project: project).id.to_s
admin.pref.save!
# a second, smaller project that is on track (for the portfolio and the cross-project workload)
second = Project.find_by(identifier: 'demo2') || Project.create!(name: TEXT[:project2], identifier: 'demo2', is_public: true, trackers: Tracker.all,
                                                                 enabled_module_names: project.enabled_module_names)
users.each { |u| Member.create!(project: second, principal: u, roles: [role]) unless second.members.exists?(user_id: u.id) }
if second.issues.empty?
  prev = nil
  TEXT[:tasks2].zip([6, 8, 5, 1], [users[1], users[2], users[0], users[0]], [100, 50, 0, 0]).each do |name, days, who, done|
    s0 = prev ? cal.step(prev.due_date, 1) : cal.step(cal.next_working_day(today), -8)
    i = Issue.create!(project: second, tracker: tracker, author: admin, status: if done == 100
                                                                                  st_done
                                                                                else
                                                                                  (done.positive? ? st_doing : tracker.default_status)
                                                                                end,
                      subject: name, start_date: s0, due_date: cal.step(s0, days - 1), estimated_hours: days * 6, done_ratio: done, assigned_to: who)
    i.update_columns(created_on: (s0 - 14).to_time)
    IssueRelation.create!(issue_from: prev, issue_to: i, relation_type: 'precedes') if prev
    prev = i
  end
  Gantrix::Baselines.add(second, name: TEXT[:baseline], at: Time.now, user: admin)
end
puts 'Demo project created: /projects/demo/gantrix'
