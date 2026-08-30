#!/usr/bin/env bash
# End-to-end smoke test: build, boot, and confirm the API answers.
set -euo pipefail

export APP_PASSWORD="${APP_PASSWORD:-smoke-test-password}"
docker compose build
docker compose up -d

cleanup() { docker compose down -v; }
trap cleanup EXIT

for _ in $(seq 1 30); do
  if curl -sf -o /dev/null http://localhost:8080/; then break; fi
  sleep 2
done

echo "--- unauthenticated request must be rejected"
code=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/api/status)
test "$code" = "401" || { echo "expected 401, got $code"; exit 1; }

echo "--- login and read status"
curl -sf -c /tmp/smoke-cookies -H 'Content-Type: application/json' \
  -d "{\"password\":\"$APP_PASSWORD\"}" http://localhost:8080/api/session > /dev/null
curl -sf -b /tmp/smoke-cookies http://localhost:8080/api/status | grep -q '"miner"'

echo "--- frontend is served"
curl -sf http://localhost:8080/ | grep -q '<div id="root">'

echo "SMOKE OK"
