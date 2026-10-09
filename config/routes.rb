# frozen_string_literal: true

# Pages of a project: /projects/:id/gantrix (schedule), .../dashboard, .../kanban, .../report.
# The screens call the internal API under .../gantrix/api (not Redmine's REST API).
scope 'projects/:project_id/gantrix' do
  get '', to: 'gantrix#show', as: 'project_gantrix'
  get 'dashboard', to: 'gantrix_dashboard#show', as: 'project_gantrix_dashboard'
  get 'kanban', to: 'gantrix_kanban#show', as: 'project_gantrix_kanban'
  get 'report', to: 'gantrix_reports#show', as: 'project_gantrix_report'

  scope 'api', as: 'project_gantrix_api' do
    get 'schedule', to: 'gantrix#data', as: 'schedule'
    put 'preferences', to: 'gantrix#save_preferences'
    post 'tasks', to: 'gantrix#create_task'
    patch 'tasks', to: 'gantrix#batch_update'
    post 'tasks/import', to: 'gantrix#import_tasks'
    patch 'tasks/:issue_id', to: 'gantrix#update_task'
    delete 'tasks/:issue_id', to: 'gantrix#destroy_task'
    post 'tasks/restore', to: 'gantrix#restore_tasks'
    post 'tasks/:issue_id/move', to: 'gantrix#move_task'
    post 'tasks/:issue_id/place', to: 'gantrix#place_task'
    post 'reschedule/preview', to: 'gantrix#reschedule_preview'
    post 'reschedule', to: 'gantrix#reschedule'
    post 'baselines', to: 'gantrix#create_baseline'
    delete 'baselines/:baseline_id', to: 'gantrix#destroy_baseline'
    get 'dashboard', to: 'gantrix_dashboard#data', as: 'dashboard'
    get 'kanban', to: 'gantrix_kanban#data', as: 'kanban'
    get 'evm', to: 'gantrix_reports#evm', as: 'evm'
  end
end

# Across projects: /gantrix/portfolio (also .csv for the weekly report), /gantrix/workload
get 'gantrix/portfolio', to: 'gantrix_portfolio#show', as: 'gantrix_portfolio'
get 'gantrix/workload', to: 'gantrix_portfolio#workload_page', as: 'gantrix_workload'
get 'gantrix/api/portfolio', to: 'gantrix_portfolio#data', as: 'gantrix_api_portfolio'
get 'gantrix/api/workload', to: 'gantrix_portfolio#workload', as: 'gantrix_api_workload'

# Administration
get 'admin/gantrix', to: 'gantrix_settings#show', as: 'gantrix_settings'
patch 'admin/gantrix', to: 'gantrix_settings#update'
post 'admin/gantrix/holidays/refresh', to: 'gantrix_settings#refresh', as: 'gantrix_settings_refresh'
post 'admin/gantrix/holidays/import', to: 'gantrix_settings#import', as: 'gantrix_settings_import'
delete 'admin/gantrix/holidays/import', to: 'gantrix_settings#clear_import'
