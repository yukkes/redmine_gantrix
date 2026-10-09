# frozen_string_literal: true

# Gantrix::Workflow (the statuses a kanban card can move to) must agree with Redmine's own
# Issue#new_statuses_allowed_to: bin/rails runner /seed/checks/workflow.rb [project identifier]
require_relative '../runner_setup'

project = Project.find_by(identifier: ARGV[0] || 'demo')
users = [User.find_by(login: 'admin'), *project.users.where(admin: false).first(3)]
bad = []
checks = 0
users.each do |user|
  User.current = user
  rows = Gantrix::IssueRows.new(project.issues.visible(user)).to_a.last(400)
  fast = Gantrix::Workflow.new(project, user).allowed(rows)
  Issue.where(id: rows.map(&:id)).find_each do |i|
    checks += 1
    want = i.new_statuses_allowed_to(user).map(&:id) - [i.status_id]
    bad << "#{user.login} ##{i.id}: #{fast[i.id].inspect} / #{want.inspect}" unless fast[i.id].sort == want.sort
  end
end
# a blocked issue (cannot be closed) and a subtask of a closed parent (cannot be reopened), rolled back afterwards
User.current = users.first
closed = IssueStatus.where(is_closed: true).first
ActiveRecord::Base.transaction do
  open_leaves = project.issues.open.where('rgt - lft = 1').where.not(parent_id: nil).limit(3).to_a
  blocker, blocked, child = open_leaves
  if child
    IssueRelation.where(issue_from_id: [blocker.id, blocked.id], issue_to_id: [blocker.id, blocked.id]).delete_all
    IssueRelation.create!(issue_from: blocker, issue_to: blocked, relation_type: IssueRelation::TYPE_BLOCKS)
    Issue.where(id: child.parent_id).update_all(status_id: closed.id)
    ids = [blocked.id, child.id]
    fast = Gantrix::Workflow.new(project, users.first).allowed(Gantrix::IssueRows.new(project.issues.where(id: ids)).to_a)
    Issue.where(id: ids).find_each do |i|
      checks += 1
      want = i.new_statuses_allowed_to(users.first).map(&:id) - [i.status_id]
      bad << "special ##{i.id}: #{fast[i.id].inspect} / #{want.inspect}" unless fast[i.id].sort == want.sort
    end
  end
  raise ActiveRecord::Rollback
end
puts bad.first(10)
puts bad.empty? ? "WORKFLOW CHECKS OK (#{checks})" : "WORKFLOW CHECKS FAILED: #{bad.size} of #{checks}"
