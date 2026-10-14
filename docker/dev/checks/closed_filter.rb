# frozen_string_literal: true

# The "in progress" view of the schedule: bin/rails runner /seed/checks/closed_filter.rb
# only current open leaves and their ancestors are shown. Completed and old branches stay hidden even
# when expanded. WBS numbers, parent rollups, hidden predecessors and the summary still count all tasks.
require_relative '../runner_setup'
ok = true
check = lambda { |name, cond, detail = ''|
  puts "#{cond ? 'ok  ' : 'FAIL'} #{name}#{": #{detail}" unless detail.to_s.empty?}"
  ok &&= cond
}

admin = User.find_by(login: 'admin')
User.current = admin
project = Project.find_by(identifier: 'closedcheck')
project&.destroy
project = Project.create!(name: 'closed filter check', identifier: 'closedcheck', is_public: false, trackers: Tracker.all,
                          enabled_module_names: Redmine::AccessControl.available_project_modules.map(&:to_s))
tracker = project.trackers.first
closed = IssueStatus.where(is_closed: true).first
d0 = Date.today - 60
mk = lambda do |subject, parent = nil, start = d0, days = 5|
  Issue.create!(project: project, tracker: tracker, author: admin, status: tracker.default_status, subject: subject,
                parent_issue_id: parent&.id, start_date: start, due_date: start + days - 1, estimated_hours: days)
end
close = ->(issue, ago) { issue.reload.update_columns(status_id: closed.id, done_ratio: 100, closed_on: ago.days.ago) }
p_ = mk.call('P')
a = mk.call('A', p_)          # closed sibling of open B: hidden, but included in P's rollup
b = mk.call('B', p_, d0 + 10) # open: P is unfolded
q = mk.call('Q')              # closed parent of an open task: unfolded
mk.call('C', q)
r = mk.call('R')              # closed with all subtasks closed: hidden
r1 = mk.call('R1', r)
s = mk.call('S')              # closed recently: hidden
t = mk.call('T')              # open, its only subtask closed long ago: hidden
u = mk.call('U', t, d0, 3)
w = mk.call('W')              # closed, its only subtask open but dated more than a year ago: hidden
v = mk.call('V', w, Date.today - 400, 5)
x_ = mk.call('X')             # closed, its only subtask open without dates: unfolded
Issue.create!(project: project, tracker: tracker, author: admin, status: tracker.default_status, subject: 'Y', parent_issue_id: x_.id)
IssueRelation.create!(issue_from: r1, issue_to: b, relation_type: 'precedes')
[[a, 30], [q, 30], [r1, 30], [r, 30], [u, 30], [w, 30], [x_, 30], [s, 3]].each { |i, ago| close.call(i, ago) }

session = ActionDispatch::Integration::Session.new(Rails.application)
session.host! 'localhost'
session.get '/login'
token = session.response.body[/name="authenticity_token" value="([^"]+)"/, 1]
session.post '/login', params: { username: 'admin', password: 'admin', authenticity_token: token }
fetch = lambda do |query = {}|
  session.get '/projects/closedcheck/gantrix/api/schedule', params: query, headers: { 'Accept' => 'application/json' }
  j = JSON.parse(session.response.body)
  j['tasks'] = j['tasks']['rows'].map { |row| j['tasks']['columns'].zip(row).to_h }.index_by { |x| x['id'] }
  j
end
part = fetch.call
all = fetch.call(closed: '1')
names = ->(j) { j['tasks'].values.pluck('subject').sort }
more = ->(j) { j['tasks'].values.select { |x| x['more'] }.pluck('subject').sort }
check.call('all data', names.call(all) == %w[A B C P Q R R1 S T U V W X Y] && more.call(all).empty?, names.call(all).inspect)
check.call('in progress shows only current open leaves and their parents', names.call(part) == %w[B C P Q X Y], names.call(part).inspect)
check.call('no excluded subtasks can be loaded by expanding', more.call(part).empty?)
check.call('ancestors are context rows', part['tasks'].values.select { |x| x['context'] }.pluck('subject').sort == %w[P Q X])
check.call('number of tasks not loaded', part['hidden_count'] == 8 && part['needed'], part['hidden_count'].inspect)
check.call('WBS numbers as with all data', part['tasks'].all? { |id, x| x['wbs'] == all['tasks'][id]['wbs'] },
           part['tasks'].values.map { |x| "#{x['subject']}:#{x['wbs']}" }.join(' '))
cal = Gantrix::Calendar.from_settings
hr = part['tasks'][p_.id]['hidden']
check.call('P gets the totals of hidden A', hr && hr[0] == a.start_date.iso8601 && hr[5] == cal.working_days(a.start_date, a.due_date) &&
                                          hr[6] == hr[5] * 100 && (hr[7] - 5).abs < 1e-6, hr.inspect)
check.call('hidden A contributes its planned working days', hr && hr[9] == cal.working_days(a.start_date, a.due_date), hr.inspect)
check.call('no totals for parents with all subtasks shown', part['tasks'][q.id]['hidden'].nil? && part['tasks'][x_.id]['hidden'].nil?)
rel = part['relations'].find { |x| x['from'] == r1.id && x['to'] == b.id }
check.call('folded predecessor R1 of B is sent', rel && part['hidden_wbs'][r1.id.to_s] == all['tasks'][r1.id]['wbs'], part['hidden_wbs'].inspect)
hs = part['hidden_summary']
check.call('summary totals of hidden leaves', hs && hs['w'] == [a, r1, s, u, v].sum { |i| cal.working_days(i.start_date, i.due_date) }, hs.inspect)
check.call('no hidden totals with all data', all['hidden_summary'].nil? && all['tasks'].values.all? { |x| x['hidden'].nil? })
opened = fetch.call(open: "#{r.id},#{w.id}")
check.call('saved expanded branches cannot restore completed tasks', names.call(opened) == names.call(part), names.call(opened).inspect)
check.call('expand all keeps the same filtered tasks', names.call(fetch.call(open: 'all')) == names.call(part))

cutoff = User.current.today - GantrixController::OLD_OPEN_DAYS
old_root = mk.call('old root', nil, cutoff - 10, 1)
old_sibling = mk.call('old sibling', p_, cutoff - 1, 1)
boundary = mk.call('boundary', nil, cutoff, 1)
future = mk.call('future', nil, User.current.today + 30, 1)
old_parent = mk.call('old parent')
current_child = mk.call('current child', old_parent)
old_parent.reload.update_columns(start_date: cutoff - 20, due_date: cutoff - 10)
start_only = mk.call('start only', nil, cutoff, 1)
start_only.update_columns(due_date: nil)
old_start_only = mk.call('old start only', nil, cutoff - 1, 1)
old_start_only.update_columns(due_date: nil)
recent_old = mk.call('recently closed old', nil, cutoff - 1, 1)
close.call(recent_old, 1)
spanning = mk.call('spanning', nil, cutoff - 10, 20)
old_closed_parent = mk.call('old closed parent')
closed_child = mk.call('closed child', old_closed_parent)
close.call(closed_child, 30)
close.call(old_closed_parent, 30)
old_closed_parent.update_columns(start_date: cutoff - 20, due_date: cutoff - 10)
nested_parent = mk.call('nested parent')
nested_closed = mk.call('nested closed', nested_parent)
nested_leaf = mk.call('nested leaf', nested_closed)
close.call(nested_closed, 30)
completed_parent = mk.call('completed parent')
completed_middle = mk.call('completed middle', completed_parent)
completed_leaf = mk.call('completed leaf', completed_middle)
close.call(completed_leaf, 1)
recent_parent = mk.call('recent parent')
recent_leaf = mk.call('recent leaf', recent_parent)
close.call(recent_parent, 1)
close.call(recent_leaf, 1)
bounded = fetch.call
expanded = fetch.call(open: 'all')
excluded = [old_root, old_sibling, old_start_only, recent_old, v, a, r, r1, s, t, u, w,
            old_closed_parent, closed_child, completed_parent, completed_middle, completed_leaf, recent_parent, recent_leaf]
check.call('old and completed branches are excluded, regardless of parent status',
           excluded.none? { |i| bounded['tasks'].key?(i.id) }, names.call(bounded).inspect)
check.call('expand all cannot restore old tasks', excluded.none? { |i| expanded['tasks'].key?(i.id) })
check.call('365-day boundary, future, start-only and spanning tasks are included',
           [boundary, future, start_only, spanning, current_child, nested_leaf].all? { |i| bounded['tasks'].key?(i.id) })
check.call('old ancestor remains as context', bounded['tasks'][old_parent.id]&.fetch('context') == true)
check.call('closed intermediate ancestors of open grandchildren remain as context',
           [nested_parent, nested_closed].all? { |i| bounded['tasks'][i.id]&.fetch('context') == true })
check.call('excluded branches have no expand control', expanded['tasks'].values.none? { |i| i['more'] })
all = fetch.call(closed: '1')
check.call('all restores the excluded tasks', excluded.all? { |i| all['tasks'].key?(i.id) })

query = IssueQuery.create!(name: 'closed check', project: project, user: admin, visibility: Query::VISIBILITY_PRIVATE,
                           filters: { 'status_id' => { operator: '*', values: [''] } })
by_query = fetch.call(query_id: query.id)
check.call('a saved query decides the statuses itself', names.call(by_query) == names.call(all) && !by_query['needed'], names.call(by_query).inspect)

project.issues.each { |i| close.call(i, 1) }
empty = fetch.call
check.call('a project with all leaves closed has no in-progress rows', empty['tasks'].empty? && empty['hidden_count'] == all['tasks'].size)
check.call('all still shows a fully closed project', names.call(fetch.call(closed: '1')) == names.call(all))

project.destroy
puts ok ? 'CLOSED FILTER CHECKS OK' : 'CLOSED FILTER CHECKS FAILED'
exit(ok ? 0 : 1)
