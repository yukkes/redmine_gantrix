# frozen_string_literal: true

Redmine::Plugin.register :redmine_gantrix do
  name 'Gantrix'
  author 'yukkes'
  description 'Spreadsheet-style WBS schedule and Gantt chart with planned and actual dates, ' \
              'progress tracking, rescheduling, and earned value management (EVM).'
  version '0.1.0'
  url 'https://github.com/yukkes/redmine_gantrix'
  author_url 'https://github.com/yukkes'
  requires_redmine version_or_higher: '5.0.0'

  settings default: { 'holiday_source' => 'jp', 'extra_holidays' => '', 'notify_successors' => '1', 'hours_per_day' => '8',
                      'signal_red' => '0.85', 'signal_amber' => '0.95', 'signal_overdue' => '3' }

  project_module :gantrix do
    permission :view_gantrix, { gantrix: %i[show data save_preferences] }, read: true
    permission :edit_gantrix,
               { gantrix: %i[create_task update_task batch_update import_tasks destroy_task restore_tasks move_task
                             place_task reschedule_preview reschedule create_baseline destroy_baseline] }
  end

  menu :project_menu, :gantrix_dashboard,
       { controller: 'gantrix_dashboard', action: 'show' },
       caption: :label_gantrix_dashboard, after: :gantt, param: :project_id
  menu :project_menu, :gantrix,
       { controller: 'gantrix', action: 'show' },
       caption: :label_gantrix, after: :gantrix_dashboard, param: :project_id
  menu :project_menu, :gantrix_kanban,
       { controller: 'gantrix_kanban', action: 'show' },
       caption: :label_gantrix_kanban, after: :gantrix, param: :project_id

  project_module :gantrix_dashboard do
    permission :view_gantrix_dashboard, { gantrix_dashboard: %i[show data] }, read: true
  end
  project_module :gantrix_kanban do
    permission :view_gantrix_kanban, { gantrix_kanban: %i[show data] }, read: true
  end
  project_module :gantrix_report do
    permission :view_gantrix_report, { gantrix_reports: %i[show evm] }, read: true
  end
  menu :project_menu, :gantrix_report,
       { controller: 'gantrix_reports', action: 'show' },
       caption: :label_gantrix_report, after: :gantrix_kanban, param: :project_id

  menu :top_menu, :gantrix_portfolio,
       { controller: 'gantrix_portfolio', action: 'show' },
       caption: :label_gantrix_portfolio, after: :projects,
       if: proc { User.current.logged? && User.current.allowed_to?(:view_gantrix_report, nil, global: true) }

  menu :admin_menu, :gantrix_settings,
       { controller: 'gantrix_settings', action: 'show' },
       caption: :label_gantrix_settings, html: { class: 'icon icon-calendar' }
end

Rails.application.config.after_initialize do
  Issue.include RedmineGantrix::IssueHooks
  TrashedIssue.include RedmineGantrix::TrashHooks if Redmine::Plugin.installed?(:redmine_issue_trash)
end
