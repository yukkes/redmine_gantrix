# frozen_string_literal: true

# Custom fields owned by the plugin (instead of plugin tables). They are created on
# first use and referenced by id (stored in the plugin settings), so admins may rename them.
class Gantrix::Fields
  DEFS = {
    'cf_actual_start' => { klass: 'IssueCustomField', format: 'date', visible: true, name: :field_gantrix_actual_start },
    'cf_actual_end' => { klass: 'IssueCustomField', format: 'date', visible: true, name: :field_gantrix_actual_end },
    # not attached to any tracker/project, so it never shows on issue pages or lists;
    # the plugin reads and writes its custom_values directly
    'cf_position' => { klass: 'IssueCustomField', format: 'int', visible: true, unattached: true, name: :field_gantrix_position }
  }.freeze

  class << self
    # Ensure every field exists; returns { key => id }.
    def ensure!
      settings = Gantrix::HolidaySource.settings
      ids = {}
      changes = {}
      DEFS.each do |key, d|
        field = find(key, settings)
        unless field
          field = create(d)
          changes[key] = field.id
        end
        ids[key] = field.id
      end
      Gantrix::HolidaySource.update(changes) if changes.any?
      ids
    end

    def id(key)
      (Gantrix::HolidaySource.settings[key].presence || ensure![key]).to_i
    end

    # [{key, field or nil}] for the settings page
    def status
      settings = Gantrix::HolidaySource.settings
      DEFS.keys.map { |key| [key, find(key, settings)] }
    end

    private

    def find(key, settings)
      klass = DEFS[key][:klass].constantize
      settings[key].present? ? klass.find_by(id: settings[key]) : nil
    end

    def create(d)
      klass = d[:klass].constantize
      lang = Setting.default_language.presence || 'en'
      name = ::I18n.t(d[:name], locale: lang)
      existing = klass.find_by(name: name, field_format: d[:format])
      return existing if existing

      field = klass.new(name: unique_name(klass, name), field_format: d[:format], visible: d[:visible],
                        description: ::I18n.t(:text_gantrix_cf_description, locale: lang))
      if field.is_a?(IssueCustomField)
        field.is_for_all = !d[:unattached]
        field.tracker_ids = d[:unattached] ? [] : Tracker.ids
        field.is_filter = false if d[:unattached]
      end
      field.save!
      field
    end

    def unique_name(klass, name)
      n = name
      i = 2
      while klass.exists?(name: n)
        n = "#{name} (#{i})"
        i += 1
      end
      n
    end
  end
end
