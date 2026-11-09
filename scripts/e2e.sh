#!/usr/bin/env bash
# End-to-end check: builds db, api and web from scratch under its own compose project, checks nginx's routing and
# cache headers, runs backend/test/e2e.test.ts over HTTP through nginx, then removes that project's containers,
# volume and built images. The project name keeps it apart from the app's own stack and data, so this can run
# while `docker compose up` is serving the app.
set -euo pipefail
cd "$(dirname "$0")/.."

export API_PORT="${E2E_API_PORT:-3100}"
export WEB_PORT="${E2E_WEB_PORT:-8180}"
export DB_PORT="${E2E_DB_PORT:-5532}"
# Overrides any key in .env (the shell wins over .env in compose), so the flows never call Gemini or spend quota.
export GEMINI_API_KEY=""
# One project per port, so runs on different ports never share, or delete, each other's containers.
compose=(docker compose -p "taskapp-e2e-$API_PORT")
down=("${compose[@]}" down -v --rmi local --remove-orphans)
root=$PWD
web="http://127.0.0.1:$WEB_PORT"
# Keeps the script's exit status; a failed cleanup only warns, with docker's error and the command to finish it.
cleanup() {
  local code=$? out
  cd "$root"
  if ! out=$("${down[@]}" 2>&1); then
    echo "Cleanup failed: $out" >&2
    echo "To remove the e2e stack, run from $root: ${down[*]}" >&2
  fi
  exit "$code"
}
trap cleanup EXIT

fail() {
  echo "web check failed: $1" >&2
  exit 1
}

"${compose[@]}" up --build -d db api web
# Health through nginx proves web, its /api proxy and the API are all up.
healthy=false
for _ in $(seq 60); do
  if curl -sf --max-time 2 "$web/api/health" >/dev/null; then
    healthy=true
    break
  fi
  sleep 2
done
if [[ $healthy != true ]]; then
  echo "The app was not healthy through nginx after 2 minutes. Logs:" >&2
  "${compose[@]}" logs api web >&2
  exit 1
fi

# nginx routing and cache headers (frontend/nginx.conf).
spa_headers=$(curl -s -D - -o /dev/null "$web/tasks/new") || fail "web did not answer /tasks/new"
grep -q "^HTTP/1.1 200" <<<"$spa_headers" || fail "/tasks/new did not serve the SPA"
grep -qi "^Cache-Control: no-cache" <<<"$spa_headers" || fail "index.html is missing Cache-Control: no-cache"
index_html=$(curl -s "$web/") || fail "web did not answer /"
asset=$(grep -oE '/assets/[^"]+\.js' <<<"$index_html" | head -1 || true)
[[ -n $asset ]] || fail "no script asset named in index.html"
asset_headers=$(curl -s -D - -o /dev/null "$web$asset") || fail "web did not answer $asset"
grep -q "^HTTP/1.1 200" <<<"$asset_headers" || fail "$asset was not served"
asset_cache=$(grep -ci "^Cache-Control:" <<<"$asset_headers" || true)
[[ $asset_cache == 1 ]] || fail "$asset has $asset_cache Cache-Control headers, expected 1"
grep -qi "^Cache-Control: public, max-age=31536000, immutable" <<<"$asset_headers" ||
  fail "$asset is missing the long-lived Cache-Control"
api_headers=$(curl -s -D - -o /dev/null "$web/api") || fail "web did not answer /api"
api_redirect=$(grep -i "^Location:" <<<"$api_headers" || true)
grep -qi "^Location: /api/" <<<"$api_redirect" || fail "/api redirect lost the host port: $api_redirect"

cd backend
E2E_BASE_URL="$web" npx vitest run test/e2e.test.ts
