#!/usr/bin/env bash
# Copyright © Advanced Micro Devices, Inc., or its affiliates.
#
# SPDX-License-Identifier: MIT

# Install (if missing) and run the deskside OTel Collector with the bundled config.
# Downloads otelcol-contrib into $HALO_TOOLS/bin (no sudo) and execs it. The Galileo
# egress is read from the environment (see config.yaml):
#   GALILEO_OTLP_ENDPOINT  GALILEO_API_KEY  GALILEO_PROJECT  GALILEO_LOG_STREAM
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOLS="${HALO_TOOLS:-$HOME/halo-toolchain}"
VER="${OTELCOL_VERSION:-0.130.0}"
BIN="$TOOLS/bin/otelcol-contrib"
PORT="${OTELCOL_HTTP_PORT:-4318}"
PIDFILE="${OTELCOL_PIDFILE:-${TMPDIR:-/tmp}/glassbox-otelcol.pid}"

if [ -z "${GALILEO_OTLP_ENDPOINT:-}" ]; then
  echo "[collector] GALILEO_OTLP_ENDPOINT not set; nothing to export to" >&2
  exit 2
fi

# Idempotence: never start a second collector. Reuse the one already running -- a live
# pidfile, or something already listening on the OTLP port.
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; then
  echo "[collector] already running (pid $(cat "$PIDFILE"), pidfile $PIDFILE); reusing"
  exit 0
fi
if { command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q "127.0.0.1:$PORT "; } ||
  { command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; }; then
  echo "[collector] port $PORT already bound; a collector is up; not starting another"
  exit 0
fi

mkdir -p "$TOOLS/bin"
if [ ! -x "$BIN" ]; then
  os=linux; arch=amd64
  [ "$(uname -s)" = "Darwin" ] && os=darwin
  case "$(uname -m)" in arm64 | aarch64) arch=arm64 ;; esac
  url="https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v${VER}/otelcol-contrib_${VER}_${os}_${arch}.tar.gz"
  echo "[collector] downloading otelcol-contrib ${VER} (${os}/${arch})"
  curl -fsSL -o /tmp/otelcol.tgz "$url"
  tar -C "$TOOLS/bin" -xzf /tmp/otelcol.tgz otelcol-contrib
  rm -f /tmp/otelcol.tgz
fi
[ -x "$BIN" ] || { echo "[collector] FATAL: otelcol-contrib not available at $BIN" >&2; exit 2; }

echo "[collector] otelcol-contrib -> ${GALILEO_OTLP_ENDPOINT} (project=${GALILEO_PROJECT:-}, logstream=${GALILEO_LOG_STREAM:-})"
echo "$$" > "$PIDFILE"   # exec preserves this pid, so the pidfile holds the otelcol pid
exec "$BIN" --config "$HERE/config.yaml"
