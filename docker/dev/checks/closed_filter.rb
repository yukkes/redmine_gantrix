# frozen_string_literal: true

# The "in progress" view of the schedule: bin/rails runner /seed/checks/closed_filter.rb
# the tree is unfolded down to the open tasks (except old ones) and the recently closed ones; the other tasks
# stay folded under their parents and are loaded when unfolded. WBS numbers, the totals of the folded
# subtasks and hidden predecessors keep the screen the same as with all data.
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
a = mk.call('A', p_)          # closed long ago, next to open B: shown
b = mk.call('B', p_, d0 + 10) # open: P is unfolded
q = mk.call('Q')              # closed parent of an open task: unfolded
mk.call('C', q)
r = mk.call('R')              # closed with all subtasks closed: folded
r1 = mk.call('R1', r)
s = mk.call('S')              # closed recently: shown
t = mk.call('T')              # open, its only subtask closed long ago: folded
u = mk.call('U', t, d0, 3)
w = mk.call('W')              # closed, its only subtask open but dated more than a year ago: folded
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
check.call('in progress: top level and the subtasks of unfolded tasks', names.call(part) == %w[A B C P Q R S T W X Y], names.call(part).inspect)
check.call('folded tasks with subtasks not loaded', more.call(part) == %w[R T W], more.call(part).inspect)
check.call('no context rows', part['tasks'].values.none? { |x| x['context'] })
check.call('number of tasks not loaded', part['hidden_count'] == 3 && part['needed'], part['hidden_count'].inspect)
check.call('WBS numbers as with all data', part['tasks'].all? { |id, x| x['wbs'] == all['tasks'][id]['wbs'] },
           part['tasks'].values.map { |x| "#{x['subject']}:#{x['wbs']}" }.join(' '))
cal = Gantrix::Calendar.from_settings
hr = part['tasks'][r.id]['hidden']
check.call('R gets the totals of folded R1', hr && hr[0] == r1.start_date.iso8601 && hr[5] == cal.working_days(r1.start_date, r1.due_date) &&
                                              hr[6] == hr[5] * 100 && (hr[7] - 5).abs < 1e-6, hr.inspect)
check.call('T is a parent through folded U', (part['tasks'][t.id]['hidden']&.at(7).to_f - 3).abs < 1e-6, part['tasks'][t.id]['hidden'].inspect)
check.call('no totals for parents with all subtasks shown', part['tasks'][p_.id]['hidden'].nil? && part['tasks'][q.id]['hidden'].nil?)
rel = part['relations'].find { |x| x['from'] == r1.id && x['to'] == b.id }
check.call('folded predecessor R1 of B is sent', rel && part['hidden_wbs'][r1.id.to_s] == all['tasks'][r1.id]['wbs'], part['hidden_wbs'].inspect)
hs = part['hidden_summary']
check.call('summary totals of folded leaves (R1, U, V)', hs && hs['w'] == [r1, u, v].sum { |i| cal.working_days(i.start_date, i.due_date) }, hs.inspect)
check.call('no hidden totals with all data', all['hidden_summary'].nil? && all['tasks'].values.all? { |x| x['hidden'].nil? })
opened = fetch.call(open: "#{r.id},#{w.id}")
check.call('unfolding loads the subtasks', names.call(opened) == %w[A B C P Q R R1 S T V W X Y] && more.call(opened) == %w[T], names.call(opened).inspect)
check.call('unfolded R has no hidden totals', opened['tasks'][r.id]['hidden'].nil? && opened['hidden_count'] == 1)

query = IssueQuery.create!(name: 'closed check', project: project, user: admin, visibility: Query::VISIBILITY_PRIVATE,
                           filters: { 'status_id' => { operator: '*', values: [''] } })
by_query = fetch.call(query_id: query.id)
check.call('a saved query decides the statuses itself', names.call(by_query) == names.call(all) && !by_query['needed'], names.call(by_query).inspect)

project.destroy
puts ok ? 'CLOSED FILTER CHECKS OK' : 'CLOSED FILTER CHECKS FAILED'
