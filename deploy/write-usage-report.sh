#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
report_dir=${INKCHECK_USAGE_REPORT_DIR:-/var/log/inkcheck}
latest="$report_dir/usage-latest.txt"
history="$report_dir/usage-history.txt"
temporary="$report_dir/.usage-report.tmp"

mkdir -p "$report_dir"
cd "$repo_dir"
docker compose exec -T inkcheck node dist/usage-report.js --days 7 > "$temporary"
{
  printf 'Generated: '
  date -u '+%Y-%m-%d %H:%M:%S UTC'
  cat "$temporary"
  printf '\n\n'
} >> "$history"
mv "$temporary" "$latest"
