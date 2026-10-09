# frozen_string_literal: true

module GantrixPagesHelper
  # messages for the screens in the user's language; keys missing there fall back to English
  def gantrix_messages
    messages = (I18n.t('gantrix_js', locale: :en, default: {}) || {}).merge(I18n.t('gantrix_js', default: {}) || {})
    messages.merge(abbr_day_names: I18n.t('date.abbr_day_names'), abbr_month_names: I18n.t('date.abbr_month_names'))
  end

  # preload the icon font (a few KB) so the toolbar draws its icons in the first paint;
  # the URL must be the one gantrix.css resolves, or the browser downloads the font twice
  def gantrix_icon_font_tag
    path =
      if Redmine::VERSION::MAJOR >= 6
        asset_path('plugin_assets/redmine_gantrix/gantrix-icons.woff2') # Propshaft: digested, next to gantrix.css
      else
        asset_path('/plugin_assets/redmine_gantrix/stylesheets/gantrix-icons.woff2')
      end
    tag.link(rel: 'preload', href: path, as: 'font', type: 'font/woff2', crossorigin: 'anonymous')
  end

  # the schedule page, when the module is enabled
  def gantrix_schedule_url(project)
    project_gantrix_path(project_id: project) if project.module_enabled?(:gantrix)
  end

  # base of the internal API (quick fixes on the dashboard and the kanban use the schedule's API)
  def gantrix_api_url(project)
    "#{project_gantrix_path(project_id: project)}/api" if project.module_enabled?(:gantrix)
  end
end
