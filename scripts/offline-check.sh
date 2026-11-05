#!/usr/bin/env bash
# Verifies SATURN runs with NO network at all, including the real local model.
# Runs a scripted session inside a Linux network namespace that has no interfaces
# except loopback-down, so any attempt to reach the network fails.
#   sudo scripts/offline-check.sh [model-profile]
set -euo pipefail
cd "$(dirname "$0")/.."
HOME_DIR=$(mktemp -d)
SCRIPT=$(mktemp)
cat > "$SCRIPT" <<'EOF'
look
ask the innkeeper what she has heard about the grain shortage
buy 1 bread
/integrity
EOF
echo "== network namespace check"
unshare -n sh -c 'ip link 2>/dev/null | grep -c "state UP" || true; (getent hosts huggingface.co && echo "DNS WORKS?!") || echo "DNS/network unavailable (expected)"'
echo "== scripted session with the local model, offline"
unshare -n env SATURN_HOME="$HOME_DIR" node src/cli/play.js --seed 7 --name Wren --script "$SCRIPT" 2>&1 | sed 's/\x1b\[[0-9;]*m//g'
echo "== done (home: $HOME_DIR)"
