# frozen_string_literal: true

# Quick fixes on the dashboard and the kanban use the schedule's update API, so they need
# the schedule module and its edit permission.
module Gantrix::Access
  module_function

  def edit?(project, user = User.current)
    project.module_enabled?(:gantrix) && user.allowed_to?(:edit_gantrix, project)
  end
end
