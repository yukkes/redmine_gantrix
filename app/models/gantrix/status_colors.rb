# frozen_string_literal: true

# Colors of issue statuses inside the plugin's screens (schedule, kanban, dashboard).
# Redmine's own issue list is not changed. Without a setting, the default status of the
# trackers is gray, closed statuses are green and the others follow the palette order.
module Gantrix::StatusColors
  PALETTE = %w[#2a78d6 #eb6834 #1baf7a #eda100 #e87ba4 #4a3aa7 #e34948 #008300].freeze
  NEW = '#8c959f'
  CLOSED = '#2e8b57'

  module_function

  def map
    saved = Setting.plugin_redmine_gantrix['status_colors'] || {}
    defaults = Tracker.all.map(&:default_status_id).compact.to_set
    i = -1
    IssueStatus.sorted.to_h do |st|
      color = saved[st.id.to_s].presence
      color ||= if st.is_closed? then CLOSED
                elsif defaults.include?(st.id) then NEW
                else PALETTE[(i += 1) % PALETTE.size]
                end
      [st.id, color]
    end
  end

  def valid?(color)
    color.to_s.match?(/\A#\h{6}\z/)
  end
end
