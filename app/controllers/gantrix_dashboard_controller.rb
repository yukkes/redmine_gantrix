# frozen_string_literal: true

# ダッシュボード tab: today's topics with quick fixes, milestones, this week's load, recent changes
class GantrixDashboardController < ApplicationController
  menu_item :gantrix_dashboard
  before_action :find_project_by_project_id, :authorize
  helper :gantrix_pages
  helper :issues
  helper :custom_fields

  def show; end

  def data
    result = Gantrix::Topics.new(@project).call
    render json: result.merge(
      status_colors: Gantrix::StatusColors.map,
      users: @project.assignable_users.map { |u| { id: u.id, name: u.name } },
      recent: recent_changes,
      can_edit: Gantrix::Access.edit?(@project),
      can_comment: User.current.allowed_to?(:add_issue_notes, @project)
    )
  end

  private

  # Redmine's own wording of a change ("進捗率 を 40 から 60 に変更")
  def describe(detail)
    helpers.show_detail(detail, true)
  rescue StandardError
    detail.prop_key.to_s
  end

  def recent_changes
    Journal.joins(:issue).where(issues: { project_id: @project.id }).where(journalized_type: 'Issue')
           .includes(:user, :details, :issue).order(created_on: :desc).limit(30)
           .select { |j| j.issue.visible? && (!j.private_notes? || User.current.allowed_to?(:view_private_notes, @project)) }
           .filter_map do |j|
      # adding a subtask also writes a journal on the parent; that is noise here
      details = j.visible_details.reject { |d| d.property == 'attr' && d.prop_key == 'child_id' }
      next if details.empty? && j.notes.blank?

      [j, details.map { |d| describe(d) }]
    end.first(8).map do |j, details|
      { at: j.created_on, user: j.user&.name, issue_id: j.journalized_id, subject: j.issue.subject,
        text: [j.notes.to_s.lines.first.to_s.strip.presence, *details].compact.first(2).join(' / ') }
    end
  end
end
