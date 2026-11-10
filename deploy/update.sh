#!/usr/bin/env bash
set -euo pipefail
umask 077

root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root_dir"

if [[ $# -ne 1 ]]; then
  echo 'Usage: bash deploy/update.sh ghcr.io/owner/renewly@sha256:<digest>' >&2
  exit 2
fi
image="$1"
if [[ ! "$image" =~ ^ghcr\.io/[a-z0-9._/-]+(@sha256:[a-f0-9]{64}|:sha-[a-f0-9]{40})$ ]]; then
  echo 'Use an immutable GHCR digest or a full sha-<commit> tag.' >&2
  exit 2
fi
[[ -f .env ]] || { echo 'Create and configure .env before deployment.' >&2; exit 2; }
command -v docker >/dev/null || { echo 'Docker is required.' >&2; exit 2; }
docker compose version >/dev/null

lock_dir="$root_dir/.deploy-lock"
mkdir "$lock_dir" 2>/dev/null || { echo 'Another deployment is active, or .deploy-lock requires inspection.' >&2; exit 1; }
trap 'rmdir "$lock_dir" 2>/dev/null || true' EXIT

export RENEWLY_IMAGE="$image"
container_id="$(docker compose ps -a -q app)"
previous_image=''
running='false'
if [[ -n "$container_id" ]]; then
  [[ "$container_id" != *$'\n'* ]] || { echo 'Only a single app instance is supported.' >&2; exit 1; }
  previous_image="$(docker inspect --format '{{.Config.Image}}' "$container_id")"
  running="$(docker inspect --format '{{.State.Running}}' "$container_id")"
fi

echo 'Pulling the requested application image.'
docker compose pull app

# Test for the SQLite file without starting the application or its scheduler.
# A fresh installation has nothing to back up yet.
has_database='false'
if docker compose run --rm --no-deps --entrypoint node app \
  -e "process.exit(require('node:fs').existsSync('/app/data/renewly.sqlite') ? 0 : 2)"; then
  has_database='true'
else
  status=$?
  [[ "$status" -eq 2 ]] || { echo 'Unable to inspect the database volume.' >&2; exit "$status"; }
fi

backup_path="/app/data/backups/pre-deploy-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
if [[ "$has_database" == true ]]; then
  echo 'Creating an online SQLite backup.'
  if [[ "$running" == true ]]; then
    docker compose exec -T app node dist/server/cli.js backup "$backup_path"
  else
    docker compose run --rm --no-deps --entrypoint node app dist/server/cli.js backup "$backup_path"
  fi
  echo "Backup created at $backup_path inside the data volume."
fi

if [[ -n "$container_id" ]]; then
  docker compose stop app
fi

if ! docker compose run --rm --no-deps --entrypoint node app dist/server/cli.js migrate; then
  echo 'Database migration failed. Deployment stopped; inspect the database and backup before recovery.' >&2
  echo 'The script does not restore or overwrite the database automatically.' >&2
  exit 1
fi

if ! docker compose up -d --no-deps --wait --wait-timeout 120 app; then
  echo 'The new application did not become healthy.' >&2
  if [[ -n "$previous_image" ]]; then
    echo 'Attempting to restart the previous application image.' >&2
    if RENEWLY_IMAGE="$previous_image" docker compose up -d --no-deps --wait --wait-timeout 120 app; then
      echo 'Previous image is running. Database changes were not rolled back.' >&2
    else
      echo 'Previous image is also unhealthy. Inspect logs and the pre-deployment database backup.' >&2
    fi
  fi
  exit 1
fi

# Only a successful update changes the server's desired image. Values are
# validated above and contain no shell or .env quoting syntax.
awk -v replacement="RENEWLY_IMAGE=$image" '
  BEGIN { replaced = 0 }
  /^RENEWLY_IMAGE=/ { if (!replaced) print replacement; replaced = 1; next }
  { print }
  END { if (!replaced) print replacement }
' .env > .env.next
chmod 600 .env.next
mv .env.next .env
mkdir -p .deploy-state
printf '%s\n' "$previous_image" > .deploy-state/previous-image
printf '%s\n' "$image" > .deploy-state/current-image
echo 'Application is healthy; deployment reference saved.'
