#!/usr/bin/env bash
# Copyright © Advanced Micro Devices, Inc., or its affiliates.
#
# SPDX-License-Identifier: MIT

# platforms/halo/run.sh — run the gateway functional loop on Strix Halo,
# with the deskside environment this box needs. Assumes platforms/halo/setup.sh has run.
#
#   bash stack/platforms/halo/run.sh            # baseline (RUN_CC=0)
#   RUN_CC=1 bash stack/platforms/halo/run.sh   # + best-effort Claude Code
set -uo pipefail

HALO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CSI="$(dirname "$(dirname "$HALO_DIR")")"   # .../stack (halo lives under platforms/)
source "$HALO_DIR/env.sh"
export RUN_CC="${RUN_CC:-0}"

# Optional direct-OTLP path: when a Galileo endpoint is configured, start the deskside
# OTel collector and point the producers at it. Additive -- HEC stays the audit sink and
# a stock run (no GALILEO_OTLP_ENDPOINT) is unchanged.
mkdir -p "$CSI/artifacts"
if [ -n "${GALILEO_OTLP_ENDPOINT:-}" ]; then
  export OTEL_EXPORTER_OTLP_ENDPOINT="${OTEL_EXPORTER_OTLP_ENDPOINT:-http://127.0.0.1:4318}"
  export AXIS_TRACE_PROPAGATION="${AXIS_TRACE_PROPAGATION:-on}"
  COLL_PIDFILE="${OTELCOL_PIDFILE:-${TMPDIR:-/tmp}/glassbox-otelcol.pid}"
  # run-collector.sh is idempotent (reuses a collector already up); the pidfile is the
  # canonical handle, so stop whatever it manages on exit -- new start or a prior orphan.
  bash "$CSI/otel-collector/run-collector.sh" >"$CSI/artifacts/collector.log" 2>&1 &
  trap 'p="$(cat "$COLL_PIDFILE" 2>/dev/null)"; [ -n "$p" ] && kill "$p" 2>/dev/null; rm -f "$COLL_PIDFILE"; true' EXIT
  echo "== OTel collector -> $GALILEO_OTLP_ENDPOINT (idempotent; log: artifacts/collector.log) =="
fi

# preflight: warn if our ports are already taken (shared-box etiquette)
busy=""
for p in "$DC_PORT" "$HEC_PORT" "$PROXY_PORT"; do
  ss -ltn 2>/dev/null | grep -q ":$p " && busy="$busy $p"
done
if [ -n "$busy" ]; then
  echo "WARNING: port(s) in use:$busy — override e.g. DC_PORT=28970 HEC_PORT=28088 PROXY_PORT=23399 bash platforms/halo/run.sh"
fi

echo "== running run_integration.sh on $(hostname) (RUN_CC=$RUN_CC, axis=$(command -v axis)) =="
cd "$CSI"
bash run_integration.sh
code=$?
echo "== exit=$code =="; echo "== SUMMARY =="; cat "$CSI/artifacts/SUMMARY.txt" 2>/dev/null
exit $code
