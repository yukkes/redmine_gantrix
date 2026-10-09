# frozen_string_literal: true

# Does Redmine's own rescheduling of following issues leave journal details?
# bin/rails runner /seed/checks/reschedule_journal.rb
require_relative '../runner_setup'
User.current = User.find_by(login: 'admin')
project = Project.find_by(identifier: 'demo')
tracker = project.trackers.first
mk = lambda { |subject, s, d|
  Issue.create!(project: project, tracker: tracker, author: User.current, subject: subject, status: tracker.default_status, start_date: s, due_date: d)
}
a = mk.call('check-pred', Date.new(2027, 2, 1), Date.new(2027, 2, 3))
b = mk.call('check-succ', Date.new(2027, 2, 4), Date.new(2027, 2, 5))
IssueRelation.create!(issue_from: a, issue_to: b, relation_type: 'precedes')
before = b.reload.journals.count
a.reload.init_journal(User.current)
a.due_date = Date.new(2027, 2, 10)
a.save!
b.reload
details = b.journals.offset(before).flat_map(&:details).select { |d| d.property == 'attr' }.map { |d| "#{d.prop_key}: #{d.old_value} -> #{d.value}" }
puts "Redmine #{Redmine::VERSION}: follower moved to #{b.start_date}..#{b.due_date}; journal details: #{details.inspect}"
puts(details.any? { |x| x.start_with?('start_date') } ? 'RESULT: journaled' : 'RESULT: NOT journaled')
[b, a].each(&:destroy)
