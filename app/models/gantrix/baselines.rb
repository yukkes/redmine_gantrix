# frozen_string_literal: true

require 'json'
require 'securerandom'

# Baselines are only "name + point in time", kept in the plugin settings per project
# (settings 'baselines' => { project_id => [items] }). The planned dates of a baseline are
# rebuilt from journals (Gantrix::History), so nothing else is stored.
class Gantrix::Baselines
  class Error < StandardError; end

  KEY = 'baselines'

  class << self
    def list(project)
      Array((Gantrix::Settings.read[KEY] || {})[project.id.to_s])
    end

    def get(project, id)
      list(project).detect { |b| b['id'] == id.to_s }
    end

    def add(project, name:, at:, user:)
      item = { 'id' => SecureRandom.hex(4), 'name' => name.to_s[0, 255], 'at' => at.iso8601(6), 'user_id' => user&.id }
      write(project) { |items| items << item }
      item
    end

    def remove(project, id)
      write(project) { |items| items.reject! { |b| b['id'] == id.to_s } }
    end

    private

    def write(project)
      Gantrix::Settings.change do |s|
        all = (s[KEY] || {}).dup
        items = Array(all[project.id.to_s]).dup
        yield items
        items.empty? ? all.delete(project.id.to_s) : (all[project.id.to_s] = items)
        s[KEY] = all
      end
    end
  end
end
