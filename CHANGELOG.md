# Changelog

## 0.1.1

- In-progress schedules: show open-status leaf tasks whose due date (or start date when no due date
  exists) is on or after today minus 365 days, plus their ancestors. Include undated and future tasks.
  Exclude recently closed tasks and branches without matching open leaves, even when expanded.
  Preserve WBS numbers and totals from hidden tasks; leave the All and saved-query views unchanged.
- Keep large saved-query menus within the viewport, make them scrollable, and wrap long labels.
- Align working-day progress lines with scheduled bar boundaries, including overdue and completed
  tasks and weighted collapsed-parent totals that include hidden children. Keep overdue progress
  anchored to its scheduled position, cap progress at the end of today, and show a separate gray
  dashed today marker on that boundary. Preserve line continuity across scrolling and print pages.
- Center dependency handles on bar ends, keep them above status labels, and preserve dragging
  through row selection while keeping finish-date resizing available. Keep handles visible during
  dragging, accept other handles as drop targets, and prevent overlap with fixed columns.
- Update English and Japanese filtering help and hidden-task labels, and add filtering, progress-line,
  menu, printing, and dependency-interaction regression checks.

## 0.1.0

First release.

- Schedule: spreadsheet-style WBS with a Gantt chart, planned and actual dates, progress, dependencies,
  critical path, rescheduling with a preview, baselines, tree view, and undo/redo (through the trash of
  redmine_issue_trash when it is installed).
- Dashboard, Kanban and Report (earned value management) per project, and a Portfolio across projects.
- Working-day calendar with Japanese holidays and company holidays (Administration > Gantrix settings).
- Bundled theme `gantrix`: Redmine's default layout with the colors and icons of lychee_theme_basic.
- No database tables of its own: data is kept in Redmine's tables, custom fields and settings.
- Supports Redmine 5.0, 5.1, 6.0, 6.1 and 7.0.
