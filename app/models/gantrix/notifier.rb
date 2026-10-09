# frozen_string_literal: true

# Mails the assignee of a successor task when all of its predecessors are done
# (closed, or progress 100%), so the next person knows the task can start.
module Gantrix::Notifier
  module_function

  def enabled?
    Setting.plugin_redmine_gantrix['notify_successors'].to_s != '0'
  end

  def done?(issue)
    issue.closed? || issue.done_ratio.to_i >= 100
  end

  # called after +issue+ became done
  def predecessor_done(issue)
    return unless enabled? && issue.project&.module_enabled?(:gantrix)

    IssueRelation.where(issue_from_id: issue.id, relation_type: IssueRelation::TYPE_PRECEDES).includes(:issue_to).each do |rel|
      succ = rel.issue_to
      next if succ.nil? || succ.closed?

      preds = IssueRelation.where(issue_to_id: succ.id, relation_type: IssueRelation::TYPE_PRECEDES).includes(:issue_from).filter_map(&:issue_from)
      next unless preds.all? { |p| done?(p) }

      recipients(succ).each { |user| Gantrix::Mailer.predecessor_done(user, succ, issue).deliver_later }
    end
  end

  def recipients(issue)
    who = issue.assigned_to
    users = who.is_a?(Group) ? who.users.to_a : [who].compact
    users.select do |u|
      u.is_a?(User) && u.active? && u.mail.present? && u.mail_notification != 'none' && u != User.current && issue.visible?(u)
    end
  end
end
