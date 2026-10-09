#!/usr/bin/env bash
# README screenshots in English and Japanese: for each language, a fresh Redmine 6.1 with demo data in that
# language (task names, users, statuses and the admin's language), then docker/dev/screenshots.js.
# Usage: NODE_PATH=<dir with playwright>/node_modules docker/dev/screenshots.sh
# Afterwards only Redmine 6.1 runs, with the Japanese data; docker/dev/up.sh starts all versions again.
set -euo pipefail
cd "$(dirname "$0")/../.."
export COMPOSE_FILE=docker/dev/compose.yml
docker/dev/companions.sh
for lang in en ja; do
  docker compose down -v >/dev/null 2>&1 || true
  docker compose up -d redmine-6.1 >/dev/null
  for _ in $(seq 1 90); do curl -fsS -o /dev/null --max-time 3 "http://127.0.0.1:3006/login" 2>/dev/null && break; sleep 2; done
  docker compose exec -T -e DEMO_LANG="$lang" redmine-6.1 bin/rails runner /seed/seed_demo.rb | grep "Demo project created"
  node docker/dev/screenshots.js 3006 docs/screenshots "$lang"
done
