#!/usr/bin/env bash
# Download the recommended companion plugins (pinned versions) into docker/dev/companions/.
# They are not part of this plugin; keep the versions in step with docker/deploy/Dockerfile.
set -euo pipefail
cd "$(dirname "$0")"
plugins=(
  "redmine_issue_trash agileware-jp/redmine_issue_trash refs/tags/v1.0.3"
  "redmine_issue_templates agileware-jp/redmine_issue_templates 87360e7db5f274b3572234c3e1806aeb2772f409"
  "redmine_microsoftteams yukkes/redmine_microsoftteams 13588b917e36f37c875ab196ea793f87d99464fd"
  "redmine_merge_request_links yukkes/redmine_merge_request_links e021a2424b3ce071a9de7be353125a9829072198"
  "redmine_textile_transparent yukkes/redmine_textile_transparent bd8a2fba3cf95eb5ff29132ec404347fd3486e24"
)
dest=companions
mkdir -p "$dest"
names=()
for p in "${plugins[@]}"; do
  read -r name repo ref <<<"$p"
  dir="$dest/$name"
  names+=("$name")
  # .ref records what was downloaded, so a new pin replaces the old copy
  [ -f "$dir/init.rb" ] && [ "$(cat "$dir/.ref" 2>/dev/null)" = "$ref" ] && continue
  rm -rf "$dir" && mkdir -p "$dir"
  curl -fsSL --max-time 120 "https://codeload.github.com/$repo/tar.gz/$ref" | tar -xz -C "$dir" --strip-components=1
  echo "$ref" > "$dir/.ref"
done
rm -rf "$dest/redmine_query_bookmarks"   # no longer recommended
echo "companions ready: ${names[*]}"
