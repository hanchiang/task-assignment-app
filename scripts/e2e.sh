#!/usr/bin/env bash
# End-to-end check: builds the stack from scratch under its own compose project, runs backend/test/e2e.test.ts
# over HTTP, then removes that project's containers, volume and built image. The project name keeps it apart
# from the app's own stack and data, so this can run while `docker compose up` is serving the app.
set -euo pipefail
cd "$(dirname "$0")/.."

export API_PORT="${E2E_API_PORT:-3100}"
# One project per port, so runs on different ports never share, or delete, each other's containers.
compose=(docker compose -p "taskapp-e2e-$API_PORT")
down=("${compose[@]}" down -v --rmi local --remove-orphans)
root=$PWD
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

"${compose[@]}" up --build -d db api
healthy=false
for _ in $(seq 60); do
  if curl -sf --max-time 2 "http://127.0.0.1:$API_PORT/api/health" >/dev/null; then
    healthy=true
    break
  fi
  sleep 2
done
if [[ $healthy != true ]]; then
  echo "The API was not healthy after 2 minutes. Its logs:" >&2
  "${compose[@]}" logs api >&2
  exit 1
fi

cd backend
E2E_BASE_URL="http://127.0.0.1:$API_PORT" npx vitest run test/e2e.test.ts
