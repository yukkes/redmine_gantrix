#!/usr/bin/env bash
# Fresh Redmine 5.0 / 5.1 / 6.0 / 6.1 / 7.0 (+ companions), seed demo data, run all checks.
# Usage: docker/dev/test_all.sh            (keeps the containers running afterwards)
#        KEEP=0 docker/dev/test_all.sh     (removes containers and volumes at the end)
#        PERF=1 docker/dev/test_all.sh     (also the speed test with 1,000 tasks; slow, left out by default)
#        docker/dev/test_all.sh 5.0 7.0    (only the given Redmine versions)
set -euo pipefail
cd "$(dirname "$0")/../.."
export COMPOSE_FILE=docker/dev/compose.yml
versions=("${@:-5.0 5.1 6.0 6.1 7.0}")
versions=(${versions[@]})
services=("${versions[@]/#/redmine-}")
declare -A port=([redmine-5.0]=3050 [redmine-5.1]=3005 [redmine-6.0]=3060 [redmine-6.1]=3006 [redmine-7.0]=3007)
docker/dev/companions.sh
docker compose down -v >/dev/null 2>&1 || true
docker compose up -d "${services[@]}"
# Playwright for the browser tests (NODE_PATH may point to a node_modules that has it)
have_playwright=0
node -e "require('playwright')" >/dev/null 2>&1 && have_playwright=1
[ "$have_playwright" = 1 ] || echo "playwright not found: browser tests are skipped (npm i playwright && npx playwright install chromium)"

# one version: prints its results, returns non-zero on a failure
test_version() {
  local s=$1 p=${port[$1]} fail=0 out
  for _ in $(seq 1 120); do curl -fsS -o /dev/null --max-time 3 "http://127.0.0.1:$p/login" 2>/dev/null && break; sleep 2; done
  echo "=== $s (port $p)"
  # the tests talk to the container directly: under WSL2, Docker's port forwarding drops a connection now and
  # then while the other servers are busy. The published port is the fallback (e.g. Docker Desktop on macOS)
  local ip target
  ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$(docker compose ps -q "$s")")
  target="$ip:3000"
  curl -fsS -o /dev/null --max-time 3 "http://$target/login" 2>/dev/null || target=$p
  echo "tests connect to $target"
  if out=$(docker compose exec -T "$s" bin/rails runner /seed/seed_demo.rb 2>&1) && echo "$out" | grep -q "Demo project created"; then
    echo "$out" | grep "Demo project created"
  else
    echo "$out" | grep -vE "^\s+from " | tail -5; echo "seeding failed on $s"; return 1
  fi
  docker compose exec -T "$s" bin/rails runner /seed/checks/reschedule_journal.rb 2>&1 | grep -E "RESULT" || fail=1
  # calculations made fast for large projects, against their plain definitions
  for c in calendar jp_holidays period workflow evm closed_filter; do
    out=$(docker compose exec -T "$s" bin/rails runner "/seed/checks/$c.rb" 2>&1 | grep -E "^FAIL|CHECKS|HOLIDAYS|skipped" || true)
    echo "$out"; echo "$out" | grep -qE "CHECKS OK|HOLIDAYS OK|skipped" || fail=1
  done
  out=$(docker compose exec -T "$s" bin/rails runner /seed/checks/scheduling.rb 2>&1 | grep -E "^FAIL|SCHEDULING" || true)
  echo "$out"; echo "$out" | grep -q "SCHEDULING CHECKS OK" || fail=1
  # UI tests first: they expect the freshly seeded demo data. Browsers run one at a time (flock): three of
  # them next to three servers make page loads slow enough to break the tests, and the timings meaningless
  if [ "$have_playwright" = 1 ]; then
    if out=$(flock "$logs/browser.lock" node docker/dev/ui_test.js "$target" 2>&1); then
      echo "$out" | tail -1
    else
      echo "$out" | grep -E "^FAIL|Error" | head -10 || true; echo "UI tests failed on $s"; fail=1
    fi
    if out=$(flock "$logs/browser.lock" node docker/dev/plugins_test.js "$target" 2>&1); then
      echo "$out" | tail -1
    else
      echo "$out" | grep -E "^FAIL|Error" | head -10 || true; echo "plugin tests failed on $s"; fail=1
    fi
    if [ "${PERF:-0}" = 1 ]; then
      docker compose exec -T "$s" bin/rails runner /seed/checks/perf_seed.rb 2>&1 | grep -E "perf project" || true
      flock "$logs/browser.lock" node docker/dev/perf_test.js "$target" 2>&1 | tail -1 || fail=1
    fi
  fi
  if out=$(python3 -I docker/dev/smoke_test.py "$target" 2>&1); then
    echo "$out" | grep -E "ALL OK|HOLIDAYS OK|baseline rebuilt|trashed task"
  else
    echo "$out" | tail -30; echo "smoke test failed on $s"; fail=1
  fi
  return $fail
}

# the JavaScript calendar does not need Redmine
node docker/dev/checks/calendar.js | tail -1 || exit 1

# the versions run side by side (separate containers and databases); their output is shown in order.
# Logs stay in the working tree (not /tmp, which may be a small tmpfs)
logs=docker/dev/.test_logs
rm -rf "$logs" && mkdir -p "$logs"
declare -A pid
for s in "${services[@]}"; do
  test_version "$s" > "$logs/$s.log" 2>&1 &
  pid[$s]=$!
done
fail=0
for s in "${services[@]}"; do
  wait "${pid[$s]}" || fail=1
  cat "$logs/$s.log"
done
rm -rf "$logs"
[ "${KEEP:-1}" = 0 ] && docker compose down -v
exit $fail
