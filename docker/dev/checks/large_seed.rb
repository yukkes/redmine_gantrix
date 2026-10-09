# frozen_string_literal: true

# A project the size of a long-running real one, for performance checks: bin/rails runner /seed/checks/large_seed.rb
# 34,000 issues (98% closed, nested up to 10 levels), 135,000 journals with 265,000 details, 50,000 time entries,
# and a few out-of-range dates (a due date of 9999-12-31 for "no end", a start date in year 3).
# Rows are bulk-inserted (no callbacks), with the nested set columns computed here.
require_relative '../runner_setup'

ISSUES = Integer(ENV.fetch('LARGE_ISSUES', 34_000))
rng = Random.new(42)
LENGTHS = [0, 0, 0, 1, 2, 3, 5, 8, 13, 20, 40, 130].freeze # working length of a leaf task (days)
RATIOS = [0, 20, 50, 80].freeze
ESTIMATES = [1, 2, 4, 8, 16, 40].freeze
admin = User.find_by(login: 'admin')
User.current = admin
project = Project.find_by(identifier: 'large') ||
          Project.create!(name: '大規模（34,000件）', identifier: 'large', is_public: true, trackers: Tracker.all,
                          enabled_module_names: Redmine::AccessControl.available_project_modules.map(&:to_s))
if project.issues.exists?
  puts "large project: #{project.issues.count} issues"
  exit
end

users = User.active.where(type: 'User').to_a
role = Role.givable.first
users.each { |u| Member.create!(project: project, principal: u, roles: [role]) unless project.members.exists?(user_id: u.id) }
tracker = project.trackers.first
open_status = tracker.default_status
closed_status = IssueStatus.where(is_closed: true).first
activity = TimeEntryActivity.active.first || TimeEntryActivity.create!(name: 'Development', active: true)
now = Time.current
first_day = Date.new(2021, 12, 1)
span = (Date.new(2026, 12, 1) - first_day).to_i

# the tree: roots with subtrees; a few deep chains reach 10 levels
nodes = [] # [parent_index or nil, depth]
while nodes.size < ISSUES
  root = nodes.size
  nodes << [nil, 0]
  level = [root]
  depth = rng.rand < 0.02 ? 9 : rng.rand(1..3)
  depth.times do |d|
    next_level = []
    level.each do |p|
      (d.zero? ? rng.rand(3..20) : rng.rand(0..4)).times do
        break if nodes.size >= ISSUES

        nodes << [p, d + 1]
        next_level << (nodes.size - 1)
      end
    end
    level = next_level
    break if level.empty? || nodes.size >= ISSUES
  end
end
nodes = nodes.first(ISSUES)
children = Hash.new { |h, k| h[k] = [] }
nodes.each_with_index { |(p, _), i| children[p] << i if p }

# dates: most tasks are short; leaves first, parents span their children
start = Array.new(ISSUES)
due = Array.new(ISSUES)
nodes.each_with_index do |(p, _), i|
  next unless children[i].empty?

  s = first_day + (p ? (start[p] ||= rng.rand(span)) + rng.rand(-20..40) : rng.rand(span))
  len = LENGTHS.sample(random: rng)
  start[i] = s
  due[i] = s + len
end
nodes.each_index.reverse_each do |i|
  next if children[i].empty?

  start[i] = children[i].filter_map { |c| start[c] }.min
  due[i] = children[i].filter_map { |c| due[c] }.max
end
# out-of-range dates as found in real data
6.times { |n| due[(n * 997) + 5] = Date.new(9999, 12, 31) }
start[4999] = Date.new(3, 1, 20)

# nested set columns (lft / rgt / root_id) by a depth-first walk
lft = Array.new(ISSUES)
rgt = Array.new(ISSUES)
root_of = Array.new(ISSUES)
nodes.each_with_index do |(p, _), r|
  next if p

  counter = 1
  stack = [[r, false]]
  until stack.empty?
    i, done = stack.pop
    if done
      rgt[i] = (counter += 1) - 1
    else
      root_of[i] = r
      lft[i] = counter
      counter += 1
      stack << [i, true]
      children[i].reverse_each { |c| stack << [c, false] }
    end
  end
end

base_id = (Issue.maximum(:id) || 0) + 1
id_of = ->(i) { base_id + i }
closed = Array.new(ISSUES) { rng.rand < 0.98 }
# closed around the due date (not now: the kanban shows only what was closed in the last two weeks)
closed_at = Array.new(ISSUES) { |i| due[i] && due[i] < Date.current ? (due[i] + 1).in_time_zone : now }
created = Array.new(ISSUES) { |i| ((start[i] && start[i].year > 2000 ? start[i] : first_day) - 10).in_time_zone }
rows = nodes.each_with_index.map do |(p, _), i|
  {
    id: id_of.call(i), project_id: project.id, tracker_id: tracker.id, author_id: admin.id,
    assigned_to_id: users.sample(random: rng)&.id, status_id: (closed[i] ? closed_status : open_status).id,
    priority_id: IssuePriority.default&.id || IssuePriority.first.id, subject: "作業 #{i + 1}", description: '',
    start_date: start[i], due_date: due[i], done_ratio: closed[i] ? 100 : RATIOS.sample(random: rng),
    estimated_hours: rng.rand < 0.68 ? ESTIMATES.sample(random: rng) : nil,
    parent_id: p && id_of.call(p), root_id: id_of.call(root_of[i]), lft: lft[i], rgt: rgt[i], lock_version: 0,
    created_on: created[i], updated_on: now, closed_on: closed[i] ? closed_at[i] : nil, is_private: false
  }
end
rows.each_slice(5000) { |batch| Issue.insert_all(batch) }

# journals: status, progress and date changes over the life of each task
journal_cols = Journal.column_names
journals = []
details = []
journal_id = (Journal.maximum(:id) || 0) + 1
detail_id = (JournalDetail.maximum(:id) || 0) + 1
per_issue = 135_000.0 / ISSUES
ISSUES.times do |i|
  n = (per_issue + rng.rand(-2.0..2.0)).round.clamp(0, 12)
  at = created[i]
  n.times do |k|
    at += rng.rand(1..72).hours
    journals << { id: journal_id, journalized_type: 'Issue', journalized_id: id_of.call(i), user_id: admin.id, notes: '',
                  created_on: at, private_notes: false, updated_on: at }.slice(*journal_cols.map(&:to_sym))
    changes = [%w[status_id 1 2], ['done_ratio', (k * 10).to_s, ((k + 1) * 10).to_s]]
    changes << ['due_date', (due[i] - 1).to_s, due[i].to_s] if due[i] && k.even? && due[i].year < 9999
    changes << ['start_date', (start[i] - 1).to_s, start[i].to_s] if start[i] && k == 1 && start[i].year > 2000
    changes.each do |key, old, new|
      details << { id: detail_id, journal_id: journal_id, property: 'attr', prop_key: key, old_value: old, value: new }
      detail_id += 1
    end
    journal_id += 1
  end
end
journals.each_slice(10_000) { |batch| Journal.insert_all(batch) }
details.each_slice(10_000) { |batch| JournalDetail.insert_all(batch) }

# time entries on leaves
entries = Array.new(50_000) do
  i = rng.rand(ISSUES)
  i = rng.rand(ISSUES) until children[i].empty?
  day = start[i] && start[i].year > 2000 ? start[i] + rng.rand(0..3) : first_day
  { project_id: project.id, issue_id: id_of.call(i), user_id: admin.id, author_id: admin.id, activity_id: activity.id,
    hours: [0.5, 1, 2, 4].sample(random: rng), comments: '', spent_on: day, tyear: day.year, tmonth: day.month,
    tweek: day.cweek, created_on: now, updated_on: now }
end
entries.each_slice(10_000) { |batch| TimeEntry.insert_all(batch) }

if ActiveRecord::Base.connection.adapter_name.downcase.include?('postgres')
  %w[issues journals journal_details time_entries].each do |t|
    ActiveRecord::Base.connection.execute("SELECT setval(pg_get_serial_sequence('#{t}', 'id'), (SELECT MAX(id) FROM #{t}))")
  end
end
puts "large project: #{project.issues.count} issues, #{journals.size} journals, #{details.size} details, #{entries.size} time entries"
