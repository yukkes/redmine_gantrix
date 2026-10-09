# frozen_string_literal: true

module RedmineGantrix
  # The bundled gantrix theme restyles the mobile header, where the project-jump
  # list's <a title="project name"> tooltips show as an ugly dark box on touch
  # devices. Drop the title attribute so tapping a project never shows it.
  module JumpBoxPatch
    private

    def render_projects_for_jump_box(projects, selected: nil, query: nil)
      # only removes an attribute from Redmine's already escaped HTML, so it stays safe
      super.gsub(/ title="[^"]*"/, '').html_safe # rubocop:disable Rails/OutputSafety
    end
  end
end
