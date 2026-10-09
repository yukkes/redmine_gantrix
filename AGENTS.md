# AGENTS.md

Gantrix: a WBS and Gantt chart plugin for Redmine 5.0-7.0, with the bundled theme `gantrix`.

## Layout

- `init.rb`: plugin registration and theme loading
- `app/`, `lib/redmine_gantrix/`, `config/`: the Rails side. No tables of its own: data is kept in Redmine's tables
- `assets/javascripts/gantrix/`, `assets/stylesheets/`: the UI, plain JavaScript and CSS without a framework
- `themes/gantrix/stylesheets/application.css` is **generated**: edit `tools/theme/application.src.css` and
  `tools/theme/icons/*.svg`, then run `python3 tools/build_theme_icons.py`
- `docker/dev/`: development and test environment (ports 5.0=3050, 5.1=3005, 6.0=3060, 6.1=3006, 7.0=3007; admin/admin)

## Rules

- Keep it working on the oldest supported Redmine, 5.0 (Ruby 2.5, Rails 6.1)
- Add every message to both `config/locales/en.yml` and `ja.yml`
- Match the surrounding code, including the language and amount of comments

## Checks

```sh
rubocop
python3 tools/build_theme_icons.py --check
brakeman --force --no-pager --exit-on-warn --exit-on-error --skip-files docker/ .
docker/dev/up.sh 7.0              # start Redmine with demo data (all versions when none is given)
docker/dev/test_all.sh 5.0 7.0    # every check, browser tests included (needs Playwright)
```

The theme CSS is read when Redmine starts: restart the container after changing it. Check visual changes with
Playwright on Redmine 5.0 and on 6 or later (their CSS and icon markup differ), at desktop and phone widths, and
open menus and other parts that only appear on interaction. The demo data is seeded around today, so tests must
not depend on fixed dates.

## Commits

- Follow [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): summary`, in English,
  imperative, lowercase. For example `fix(theme): ...`, `feat: ...`, `ci: ...`
- No trailers such as `Co-Authored-By`
- Few commits, each grouping one coherent change
