# frozen_string_literal: true

class Gantrix::Workflow
  def initialize(project, user)
    @project = project
    @user = user
  end

  # { issue id => ids of the statuses it can move to } for Gantrix::IssueRows rows of the project:
  # Issue#new_statuses_allowed_to for hundreds of cards without loading
  # them. The workflow part depends only on tracker, status and whether the user is the author or the
  # assignee, so it is read once per combination; the two exceptions (a blocked issue cannot be closed,
  # a subtask of a closed parent cannot be reopened) are found for all cards with one query each. Cards
  # with subtasks of their own (hidden from the user) are left to Redmine.
  def allowed(cards)
    ids = cards.map(&:id)
    user = @user
    roles = (user.admin? ? Role.all.to_a : user.roles_for_project(@project)).select(&:consider_workflow?)
    groups = user.group_ids
    statuses = IssueStatus.all.index_by(&:id)
    trackers = Tracker.all.index_by(&:id)
    blocked = IssueRelation.joins('INNER JOIN issues blocker ON blocker.id = issue_relations.issue_from_id')
                           .joins('INNER JOIN issue_statuses bs ON bs.id = blocker.status_id')
                           .where(relation_type: IssueRelation::TYPE_BLOCKS, issue_to_id: ids, bs: { is_closed: false })
                           .distinct.pluck(:issue_to_id).to_set
    under_closed = Issue.joins('INNER JOIN issues a ON a.root_id = issues.root_id AND a.lft < issues.lft AND a.rgt > issues.rgt')
                        .joins('INNER JOIN issue_statuses s ON s.id = a.status_id')
                        .where(id: ids, s: { is_closed: true }).distinct.pluck(:id).to_set
    with_children = Issue.where(parent_id: ids).distinct.pluck(:parent_id).to_set
    workflow = {}
    result = cards.to_h do |c|
      next [c.id, nil] if with_children.include?(c.id)

      assignee = c.assigned_to_id.present? && (c.assigned_to_id == user.id || groups.include?(c.assigned_to_id))
      list = workflow[[c.tracker_id, c.status_id, c.author_id == user.id, assignee]] ||= begin
        allowed = IssueStatus.new_statuses_allowed(statuses[c.status_id], roles, trackers[c.tracker_id], c.author_id == user.id, assignee)
        allowed.empty? ? [] : (allowed + [statuses[c.status_id]]).compact.uniq.sort
      end
      list = list.reject(&:is_closed?) if blocked.include?(c.id)
      list = list.select(&:is_closed?) if under_closed.include?(c.id)
      [c.id, list.map(&:id) - [c.status_id]]
    end
    rest = result.select { |_, v| v.nil? }.keys
    Issue.where(id: rest).find_each { |i| result[i.id] = i.new_statuses_allowed_to(user).map(&:id) - [i.status_id] } if rest.any?
    result
  end
end
