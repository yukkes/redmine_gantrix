# frozen_string_literal: true

# レポート tab: earned value (EVM) of the project
class GantrixReportsController < ApplicationController
  menu_item :gantrix_report
  before_action :find_project_by_project_id, :authorize
  helper :gantrix_pages

  def show; end

  # GET evm?baseline_id= (empty: the latest baseline; "current": the current plan)
  def evm
    baselines = Gantrix::Baselines.list(@project)
    baseline = if params[:baseline_id] == 'current' then nil
               elsif params[:baseline_id].present? then baselines.detect { |b| b['id'] == params[:baseline_id].to_s }
               else baselines.max_by { |b| b['at'].to_s }
               end
    result = Gantrix::Evm.new(@project, baseline: baseline).call
    render json: result.merge(
      baseline_id: baseline ? baseline['id'] : 'current',
      baselines: baselines.map { |b| { id: b['id'], name: b['name'], at: b['at'] } },
      today: User.current.today
    )
  end
end
