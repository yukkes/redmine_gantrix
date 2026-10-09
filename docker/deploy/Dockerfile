# syntax=docker/dockerfile:1
# Redmine 7 image bundling this plugin with companion plugins:
#   - redmine_gantrix              (this repository)
#   - redmine_microsoftteams       (yukkes)
#   - redmine_merge_request_links  (yukkes)
#   - redmine_textile_transparent  (yukkes)
#   - redmine_issue_templates      (Agileware)
#   - redmine_issue_trash          (Agileware)
# Keep the versions in step with docker/dev/companions.sh.
#   (the theme "gantrix" ships with redmine_gantrix; select it in Administration > Settings > Display)
#
# Build from the repository root:
#   docker build -f docker/deploy/Dockerfile -t redmine-gantrix:7.0 .
# Run with PostgreSQL 17: docker compose -f docker/deploy/compose.yml up -d --build
# Or standalone (SQLite, for trial):
#   docker run -d -p 127.0.0.1:3000:3000 -e SECRET_KEY_BASE=... redmine-gantrix:7.0
ARG REDMINE_VERSION=7.0

FROM redmine:${REDMINE_VERSION} AS fetch
ARG MICROSOFTTEAMS_REF=13588b917e36f37c875ab196ea793f87d99464fd
ARG MERGE_REQUEST_LINKS_REF=e021a2424b3ce071a9de7be353125a9829072198
ARG TEXTILE_TRANSPARENT_REF=bd8a2fba3cf95eb5ff29132ec404347fd3486e24
ARG ISSUE_TEMPLATES_REF=87360e7db5f274b3572234c3e1806aeb2772f409
ARG ISSUE_TRASH_VERSION=v1.0.3
WORKDIR /fetch
RUN set -eux; \
    fetch_git() { \
      mkdir -p "plugins/$1"; \
      git -C "plugins/$1" init -q; \
      git -C "plugins/$1" fetch -q --depth 1 "$2" "$3"; \
      git -C "plugins/$1" checkout -q FETCH_HEAD; \
      rm -rf "plugins/$1/.git"; \
    }; \
    fetch_git redmine_microsoftteams https://github.com/yukkes/redmine_microsoftteams.git "$MICROSOFTTEAMS_REF"; \
    fetch_git redmine_merge_request_links https://github.com/yukkes/redmine_merge_request_links.git "$MERGE_REQUEST_LINKS_REF"; \
    fetch_git redmine_textile_transparent https://github.com/yukkes/redmine_textile_transparent.git "$TEXTILE_TRANSPARENT_REF"; \
    fetch_git redmine_issue_templates https://github.com/agileware-jp/redmine_issue_templates.git "$ISSUE_TEMPLATES_REF"; \
    fetch_git redmine_issue_trash https://github.com/agileware-jp/redmine_issue_trash.git "refs/tags/$ISSUE_TRASH_VERSION"; \
    # Development-only files that Redmine does not need at runtime.
    rm -rf plugins/*/Dockerfile plugins/*/docker-compose.yml plugins/*/.github plugins/*/test plugins/*/spec \
           plugins/redmine_merge_request_links/evidence \
           plugins/redmine_merge_request_links/examples

# This plugin is the repository root; Dockerfile.dockerignore sends only its runtime files
# (and additional_environment.rb, which goes to config/ below).
FROM redmine:${REDMINE_VERSION} AS gantrix
COPY . /gantrix/
RUN rm -rf /gantrix/docker

FROM redmine:${REDMINE_VERSION}
COPY --from=fetch --chown=redmine:redmine /fetch/plugins/ /usr/src/redmine/plugins/
# Gems the plugins add (httpclient for redmine_microsoftteams), so the container does not install them on start.
# Redmine's Gemfile picks the database gems from config/database.yml: name every adapter, as the base image does,
# so that Gemfile.lock keeps them all.
RUN set -eux; \
    for adapter in mysql2 postgresql sqlserver sqlite3; do \
      printf '%s:\n  adapter: %s\n' "$adapter" "$adapter" >> config/database.yml; \
    done; \
    bundle install; \
    rm config/database.yml
# Gantrix adds no gems: copied after bundle install, so that a change to it does not reinstall them.
COPY --from=gantrix --chown=redmine:redmine /gantrix/ /usr/src/redmine/plugins/redmine_gantrix/
# gzip compression and long-lived caching of fingerprinted assets
COPY --chown=redmine:redmine docker/deploy/additional_environment.rb /usr/src/redmine/config/additional_environment.rb
# Let the official entrypoint run `rake redmine:plugins:migrate` on start.
ENV REDMINE_PLUGINS_MIGRATE=1
