# frozen_string_literal: true

# 全体レポート (top menu): the projects the user can see the report of: portfolio rows,
# a weekly CSV for status reports, and the workload of assignees across those projects.
class GantrixPortfolioController < ApplicationController
  before_action :require_login, :authorize_portfolio
  helper :gantrix_pages

  # GET gantrix/portfolio (.csv: the weekly status report)
  def show
    @tab = 'projects'
    respond_to do |format|
      format.html
      format.csv { send_csv }
    end
  end

  # GET gantrix/workload: the second tab of the same page
  def workload_page
    @tab = 'workload'
    render :show
  end

  def data
    projects = scope.to_a
    render json: {
      today: User.current.today, thresholds: Gantrix::Portfolio.thresholds,
      projects: Gantrix::Portfolio.new(projects).rows,
      parents: projects.filter_map(&:parent).uniq.map { |p| { id: p.id, name: p.name } }
    }
  end

  def workload
    weeks = params[:weeks].to_i.clamp(4, 26)
    weeks = 12 if params[:weeks].blank?
    render json: Gantrix::Workload.new(scope.to_a, from: User.current.today, weeks: weeks).call
  end

  private

  # weekly status report as CSV (UTF-8 with BOM so that Excel opens it as is)
  def send_csv
    rows = Gantrix::Portfolio.new(scope.to_a).rows
    head = %w[project parent signal start finish forecast planned_progress progress spi cpi overdue milestone milestone_date milestone_late_days]
           .map { |k| l("label_gantrix_csv_#{k}") }
    data = CSV.generate do |out|
      out << head
      rows.each do |r|
        m = r[:milestone] || {}
        out << [r[:name], r[:parent], l("label_gantrix_signal_#{r[:signal]}"), r[:start], r[:finish], r[:forecast],
                r[:planned_progress], r[:progress], r[:spi], r[:cpi], r[:overdue], m[:name], m[:date], m[:late_days]]
      end
    end
    send_data "\uFEFF#{data}", type: 'text/csv; charset=utf-8', filename: "portfolio_#{User.current.today.strftime('%Y%m%d')}.csv"
  end

  def scope
    Project.active.visible.allowed_to(User.current, :view_gantrix_report).where(id: EnabledModule.where(name: 'gantrix_report').select(:project_id))
           .includes(:parent).order(:lft)
  end

  def authorize_portfolio
    deny_access unless User.current.allowed_to?(:view_gantrix_report, nil, global: true)
  end
end
