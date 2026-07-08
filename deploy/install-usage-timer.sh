#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this installer with sudo." >&2
  exit 1
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
escaped_repo=$(printf '%s' "$repo_dir" | sed 's/[&|]/\\&/g')

sed "s|__REPO_DIR__|$escaped_repo|g" \
  "$script_dir/inkcheck-usage-report.service.in" \
  > /etc/systemd/system/inkcheck-usage-report.service
install -m 0644 "$script_dir/inkcheck-usage-report.timer" \
  /etc/systemd/system/inkcheck-usage-report.timer
systemctl daemon-reload
systemctl enable --now inkcheck-usage-report.timer
systemctl start inkcheck-usage-report.service
systemctl --no-pager status inkcheck-usage-report.timer

echo "Latest report: /var/log/inkcheck/usage-latest.txt"
echo "Report history: /var/log/inkcheck/usage-history.txt"
