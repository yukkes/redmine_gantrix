#!/usr/bin/env bash
# Start Redmine 5.0 / 5.1 / 6.0 / 6.1 / 7.0 and load demo data.
# Usage: docker/dev/up.sh [5.0 5.1 6.0 6.1 7.0]   (Redmine versions; all by default)
set -euo pipefail
cd "$(dirname "$0")/../.."
export COMPOSE_FILE=docker/dev/compose.yml
versions=("${@:-5.0 5.1 6.0 6.1 7.0}")
versions=(${versions[@]})
services=("${versions[@]/#/redmine-}")
docker/dev/companions.sh
docker compose up -d "${services[@]}"
for s in "${services[@]}"; do
  echo "waiting for $s ..."
  for _ in $(seq 1 90); do
    if curl -fsS -o /dev/null "http://127.0.0.1:$(docker compose port "$s" 3000 | cut -d: -f2)/login" 2>/dev/null; then break; fi
    sleep 2
  done
  docker compose exec -T "$s" bin/rails runner /seed/seed_demo.rb
done
docker compose ps
