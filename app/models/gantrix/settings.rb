# frozen_string_literal: true

# The plugin settings (one row in Redmine's settings table). Changes are merged under a
# row lock and re-read from the database, so that saves from different screens or
# processes (holiday cache, baselines, the admin page) never overwrite each other.
module Gantrix::Settings
  NAME = 'plugin_redmine_gantrix'

  module_function

  def read
    (Setting.plugin_redmine_gantrix || {}).to_h.transform_keys(&:to_s)
  end

  def update(changes)
    change { |h| h.merge!(changes.transform_keys(&:to_s)) }
  end

  # yields the current settings (a Hash with String keys) to modify in place
  def change
    Setting.transaction do
      record = Setting.where(name: NAME).lock.first
      current = (record&.value.presence || read).to_h.transform_keys(&:to_s)
      result = yield current
      Setting.plugin_redmine_gantrix = current
      result
    end
  end
end
