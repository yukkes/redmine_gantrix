# frozen_string_literal: true

# カンバン tab: leaf tasks in status columns. Moving a card changes the status through the
# schedule's update API, so Redmine's workflow decides which columns a card can go to.
class GantrixKanbanController < ApplicationController
  menu_item :gantrix_kanban
  before_action :find_project_by_project_id, :authorize
  helper :gantrix_pages

  CLOSED_DAYS = 14 # closed cards stay on the board this long
  MAX_CARDS = 500

  def show; end

  def data
    today = User.current.today
    @rows = Gantrix::IssueRows.new(@project.issues.visible)
    issues = @rows.to_a
    tree = Gantrix::Tree.new(issues)
    recent = recently_closed_ids(today)
    cards = issues.select { |i| tree.leaf?(i.id) && (!i.closed? || recent.include?(i.id)) }
                  .sort_by { |i| [i.due_date || Date.new(9999), i.id] }.first(MAX_CARDS)
    statuses = @project.rolled_up_statuses.to_a
    statuses |= IssueStatus.where(id: cards.map(&:status_id).uniq).to_a
    colors = Gantrix::StatusColors.map
    editable = Gantrix::Access.edit?(@project)
    allowed = editable ? Gantrix::Workflow.new(@project, User.current).allowed(cards) : {}
    render json: {
      today: today, me: User.current.id, can_edit: editable,
      can_add: editable && User.current.allowed_to?(:add_issues, @project),
      default_status_id: @project.trackers.sorted.first&.default_status_id,
      statuses: statuses.sort_by(&:position).map { |s| { id: s.id, name: s.name, closed: s.is_closed?, color: colors[s.id] } },
      versions: @project.shared_versions.open.sort_by { |v| [v.effective_date || Date.new(9999), v.name] }.map { |v| { id: v.id, name: v.name } },
      cards: cards.map { |i| card(i, tree, today, allowed.fetch(i.id, [])) }
    }
  end

  private

  # closed cards stay on the board for CLOSED_DAYS after they were closed (or last updated)
  def recently_closed_ids(today)
    @project.issues.visible.joins(:status).where(issue_statuses: { is_closed: true })
            .where('COALESCE(issues.closed_on, issues.updated_on) >= ?', (today - CLOSED_DAYS).in_time_zone)
            .pluck(:id).to_set
  end

  def card(issue, tree, today, allowed)
    {
      id: issue.id, subject: issue.subject, path: tree.path(issue.id), status_id: issue.status_id,
      done_ratio: issue.done_ratio.to_i, start_date: issue.start_date, due_date: issue.due_date,
      overdue: !issue.closed? && issue.due_date.present? && issue.due_date < today,
      estimated_hours: issue.estimated_hours, assigned_to_id: issue.assigned_to_id,
      assigned_to: @rows.assignee_names[issue.assigned_to_id], fixed_version_id: issue.fixed_version_id, allowed: allowed
    }
  end
end
