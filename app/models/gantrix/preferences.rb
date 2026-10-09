# frozen_string_literal: true

# Per-user, per-project view settings of the schedule (zoom, columns, collapsed rows, ...),
# kept in the user's preferences (user_preferences.others) so no table is needed.
module Gantrix::Preferences
  KEY = :gantrix_preferences
  ZOOMS = %w[day week month].freeze
  COLUMNS = %w[status est spent astart aend preds slack].freeze
  MAX_PROJECTS = 100
  MAX_COLLAPSED = 2000

  module_function

  def get(user, project)
    return nil if user.anonymous?

    (user.pref[KEY] || {})[project.id.to_s] || {}
  end

  def set(user, project, raw)
    return if user.anonymous?

    pref = user.pref
    all = (pref[KEY] || {}).dup
    all.delete(project.id.to_s)
    all[project.id.to_s] = clean(raw)
    all = all.to_a.last(MAX_PROJECTS).to_h # oldest projects drop out first
    pref[KEY] = all
    pref.save!
  end

  def clean(raw)
    raw = raw.respond_to?(:to_unsafe_h) ? raw.to_unsafe_h : raw.to_h
    collapsed = raw['collapsed'].respond_to?(:keys) ? raw['collapsed'].keys : Array(raw['collapsed'])
    {
      'zoom' => ZOOMS.include?(raw['zoom']) ? raw['zoom'] : 'day',
      'collapsed' => collapsed.map(&:to_i).select(&:positive?).first(MAX_COLLAPSED).to_h { |id| [id.to_s, true] },
      # tasks unfolded on the screen whose subtasks the "in progress" view leaves out
      'opened' => Array(raw['opened']).map(&:to_i).select(&:positive?).uniq.first(MAX_COLLAPSED),
      'showClosed' => truthy(raw['showClosed']),
      'inazuma' => raw.key?('inazuma') ? truthy(raw['inazuma']) : true,
      'baselineId' => raw['baselineId'].to_s[0, 40],
      'extraCols' => Array(raw['extraCols']).map(&:to_s) & COLUMNS,
      'queryId' => raw['queryId'].to_i.positive? ? raw['queryId'].to_i : nil,
      'critical' => truthy(raw['critical']),
      'loadPane' => truthy(raw['loadPane'])
    }
  end

  # plugin setting used for the workload (default 8)
  def hours_per_day
    v = Setting.plugin_redmine_gantrix['hours_per_day'].to_f
    v.positive? && v <= 24 ? v : 8.0
  end

  def truthy(v)
    [true, 'true', '1', 1].include?(v)
  end
end
