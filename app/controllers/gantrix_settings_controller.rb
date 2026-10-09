# frozen_string_literal: true

# Administration > 工程表の設定: holiday source, Cabinet Office CSV cache,
# CSV import and company holidays.
class GantrixSettingsController < ApplicationController
  layout 'admin'
  self.main_menu = false if respond_to?(:main_menu=)
  menu_item :gantrix_settings
  before_action :require_admin

  def show
    Gantrix::Fields.ensure!
    @fields = Gantrix::Fields.status
    @settings = Gantrix::HolidaySource.settings
    @source = Gantrix::HolidaySource.source(@settings)
    @jp_count = Gantrix::HolidaySource.parse_list(@settings['jp_cache'])
    @imported = Gantrix::HolidaySource.parse_list(@settings['imported_holidays'])
    @year = (params[:year].presence || User.current.today.year).to_i.clamp(1970, 2199)
    @holidays = Gantrix::Calendar.from_settings.year_holidays_with_origin(@year).sort
  end

  def update
    source = params[:holiday_source].to_s
    Gantrix::HolidaySource.update(
      'holiday_source' => %w[jp imported none].include?(source) ? source : 'jp',
      'extra_holidays' => params[:extra_holidays].to_s.split(/\s+/).select { |v| Gantrix::HolidaySource.parse_date(v) }.join("\n"),
      'notify_successors' => params[:notify_successors].to_s == '0' ? '0' : '1',
      'hours_per_day' => (1..24).cover?(params[:hours_per_day].to_f) ? params[:hours_per_day].to_f.to_s : '8',
      'status_colors' => status_colors,
      'signal_red' => number_in(params[:signal_red], 0.1..2, '0.85'),
      'signal_amber' => number_in(params[:signal_amber], 0.1..2, '0.95'),
      'signal_overdue' => params[:signal_overdue].to_i.between?(1, 999) ? params[:signal_overdue].to_i.to_s : '3',
      'pm_role_ids' => Array(params[:pm_role_ids]).map(&:to_i).select(&:positive?).map(&:to_s)
    )
    flash[:notice] = l(:notice_successful_update)
    redirect_to gantrix_settings_path
  end

  def refresh
    count = Gantrix::HolidaySource.fetch_cao!
    flash[:notice] = l(:notice_gantrix_cao_fetched, count: count)
  rescue Gantrix::HolidaySource::Error => e
    flash[:error] = l(:error_gantrix_cao_fetch, message: e.message)
  ensure
    redirect_to gantrix_settings_path
  end

  def import
    file = params[:file]
    raise Gantrix::HolidaySource::Error, l(:error_gantrix_csv_no_file) unless file.respond_to?(:read)

    days = Gantrix::HolidaySource.parse_csv(file.read)
    changes = { 'imported_holidays' => Gantrix::HolidaySource.dump_list(days),
                'imported_name' => params[:name].presence || file.original_filename.to_s,
                'imported_at' => Time.now.utc.iso8601 }
    changes['holiday_source'] = 'imported' if params[:use_imported] == '1'
    Gantrix::HolidaySource.update(changes)
    flash[:notice] = l(:notice_gantrix_csv_imported, count: days.size)
  rescue Gantrix::HolidaySource::Error => e
    flash[:error] = e.message
  ensure
    redirect_to gantrix_settings_path
  end

  def clear_import
    s = Gantrix::HolidaySource.settings
    changes = { 'imported_holidays' => nil, 'imported_name' => nil, 'imported_at' => nil }
    changes['holiday_source'] = 'none' if Gantrix::HolidaySource.source(s) == 'imported'
    Gantrix::HolidaySource.update(changes)
    flash[:notice] = l(:notice_successful_delete)
    redirect_to gantrix_settings_path
  end

  private

  def number_in(value, range, default)
    range.cover?(value.to_f) ? value.to_f.to_s : default
  end

  # only colors that differ from the automatic ones are kept, so new statuses still get theirs
  def status_colors
    return {} if params[:status_colors_reset] == '1'

    defaults = Gantrix::StatusColors.map.transform_keys(&:to_s)
    saved = (Setting.plugin_redmine_gantrix['status_colors'] || {}).dup
    (params[:status_colors]&.to_unsafe_h || {}).each do |id, color|
      next unless Gantrix::StatusColors.valid?(color) && IssueStatus.exists?(id: id.to_i)

      next if color.casecmp?(defaults[id].to_s) && !saved.key?(id)

      saved[id] = color.downcase
    end
    saved
  end
end
