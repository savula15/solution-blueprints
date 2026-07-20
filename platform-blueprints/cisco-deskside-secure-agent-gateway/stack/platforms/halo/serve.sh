#!/usr/bin/env bash
# Copyright © Advanced Micro Devices, Inc., or its affiliates.
#
# SPDX-License-Identifier: MIT

# platforms/halo/serve.sh — bring up the deskside stack as STANDING services for an
# interactive Claude Code session, then print the `claude` command that routes
# inference through the Lemonade proxy and tool calls through the AXIS connector.
#
# Unlike run_integration.sh (a batch self-test that tears everything down), this
# leaves Lemonade, the DefenseClaw gateway, the proxy and the collector running so
# you can talk to Claude interactively on one shared session/trace.
#
#   bash platforms/halo/serve.sh          # bring the stack up + print the claude command
#   bash platforms/halo/serve.sh stop     # stop the standing services (leaves Lemonade)
set -uo pipefail

HALO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CSI="$(dirname "$(dirname "$HALO_DIR")")"   # .../stack
source "$HALO_DIR/env.sh"

ART="$CSI/artifacts"; mkdir -p "$ART"
SESS="${AXIS_SESSION:-cc-live}"
STATE="${AXIS_TRACE_STATE:-$TMPDIR/axis-trace-$SESS.json}"
SINK="$ART/events.jsonl"
MCP_JSON="$ART/mcp.live.json"
export LEMON_MODEL="${LEMON_MODEL:-Qwen3-8B-GGUF}"
note(){ printf '\n[serve] %s\n' "$*"; }

# `stop` kills the proxy/gateway/collector by port (cmdline-agnostic). Lemonade is
# left running on purpose — it is the heavy model server.
if [ "${1:-}" = "stop" ]; then
  for port in "$PROXY_PORT" "$DC_PORT" 4318 4317; do
    for pid in $(ss -ltnp 2>/dev/null | grep ":$port " | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u); do
      kill "$pid" 2>/dev/null && echo "[serve] stopped pid $pid on :$port"
    done
  done
  exit 0
fi

# 1. Lemonade (inference upstream) — reuse if already healthy, else start it.
if curl -sf "http://127.0.0.1:$LEMONADE_PORT/api/v1/health" >/dev/null 2>&1; then
  note "Lemonade already healthy on :$LEMONADE_PORT"
else
  note "starting Lemonade ($LEMON_MODEL) on :$LEMONADE_PORT (first run pulls the model; slow on CPU)"
  LEMONADE_PORT="$LEMONADE_PORT" LEMON_MODEL="$LEMON_MODEL" bash "$CSI/lemonade/run_lemonade.sh" >"$ART/lemonade_boot.txt" 2>&1 || true
  curl -sf "http://127.0.0.1:$LEMONADE_PORT/api/v1/health" >/dev/null 2>&1 \
    || { echo "[serve] FATAL: Lemonade not healthy; see $ART/lemonade_boot.txt"; exit 2; }
fi

# 2. DefenseClaw gateway — pin one token the gateway AND the connector share.
export DEFENSECLAW_GATEWAY_TOKEN="${DEFENSECLAW_GATEWAY_TOKEN:-cc-live-$$}"
if curl -sf "http://127.0.0.1:$DC_PORT/health" >/dev/null 2>&1; then
  note "DefenseClaw gateway already healthy on :$DC_PORT"
else
  note "starting DefenseClaw gateway on :$DC_PORT"
  DC_PORT="$DC_PORT" bash "$CSI/defenseclaw/run_gateway.sh" >"$ART/gateway_boot.txt" 2>&1 &
  for _ in $(seq 1 100); do curl -sf "http://127.0.0.1:$DC_PORT/health" >/dev/null 2>&1 && break; sleep 0.2; done
  curl -sf "http://127.0.0.1:$DC_PORT/health" >/dev/null 2>&1 \
    || { echo "[serve] FATAL: gateway not healthy; see $ART/gateway_boot.txt"; exit 2; }
fi

# 3. Collector (OTLP -> Galileo), when egress is configured.
if [ -n "${GALILEO_OTLP_ENDPOINT:-}" ]; then
  export OTEL_EXPORTER_OTLP_ENDPOINT="${OTEL_EXPORTER_OTLP_ENDPOINT:-http://127.0.0.1:4318}"
  export AXIS_TRACE_PROPAGATION="${AXIS_TRACE_PROPAGATION:-on}"
  bash "$CSI/otel-collector/run-collector.sh" >"$ART/collector.log" 2>&1 &
  note "collector -> $GALILEO_OTLP_ENDPOINT (log: artifacts/collector.log)"
fi

# 4. Proxy: inference authority. Audits + governs each call and mints the per-turn
#    trace the connector joins. LLM_CAPTURE_CONTENT lights up span input/output.
# Lemonade (CPU llama.cpp) serves only the OpenAI format; Claude Code speaks the
# Anthropic Messages API — translate the local tier so requests/responses match,
# otherwise the client gets an empty completion.
export LEMON_TRANSLATE_LOCAL="${LEMON_TRANSLATE_LOCAL:-1}"
export LLM_CAPTURE_CONTENT="${LLM_CAPTURE_CONTENT:-on}"
: > "$STATE" 2>/dev/null || true
AXIS_SESSION="$SESS" AXIS_TRACE_STATE="$STATE" \
LEMON_PROXY_PORT="$PROXY_PORT" LEMON_UPSTREAM="http://127.0.0.1:$LEMONADE_PORT" \
DEFENSECLAW_URL="http://127.0.0.1:$DC_PORT" DEFENSECLAW_GATEWAY_TOKEN="$DEFENSECLAW_GATEWAY_TOKEN" \
SPLUNK_SINK="$SINK" AXIS_TENANT="client-deskside" AXIS_USER="${USER:-amd}" \
  node "$CSI/lemonade_proxy/src/server.js" >"$ART/proxy_boot.txt" 2>&1 &
for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:$PROXY_PORT/api/v1/health" >/dev/null 2>&1 && break; sleep 0.2; done
curl -sf "http://127.0.0.1:$PROXY_PORT/api/v1/health" >/dev/null 2>&1 \
  || { echo "[serve] FATAL: proxy not healthy; see $ART/proxy_boot.txt"; exit 2; }
note "proxy healthy on :$PROXY_PORT"

# 5. mcp.json — the AXIS tool server, sharing the same session/trace/token/sink so
#    tool calls land on the proxy's trace and authenticate to the gateway.
cat > "$MCP_JSON" <<EOF
{ "mcpServers": { "axis": { "command": "node", "args": ["$CSI/axis_mcp_connector/src/server.js"],
  "env": { "AXIS_BIN": "$AXIS_BIN", "AXIS_POLICY": "$AXIS_POLICY",
    "DEFENSECLAW_URL": "http://127.0.0.1:$DC_PORT", "DEFENSECLAW_MODE": "action",
    "DEFENSECLAW_GATEWAY_TOKEN": "$DEFENSECLAW_GATEWAY_TOKEN",
    "SPLUNK_SINK": "$SINK",
    "AXIS_SESSION": "$SESS", "AXIS_TRACE_STATE": "$STATE",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "${OTEL_EXPORTER_OTLP_ENDPOINT:-}",
    "AXIS_TRACE_PROPAGATION": "${AXIS_TRACE_PROPAGATION:-off}",
    "LLM_CAPTURE_CONTENT": "$LLM_CAPTURE_CONTENT", "LLM_CAPTURE_MAX_CHARS": "${LLM_CAPTURE_MAX_CHARS:-8192}" } } } }
EOF

DISALLOW="Bash,BashOutput,KillShell,Read,Write,Edit,MultiEdit,NotebookEdit,NotebookRead,Glob,Grep,WebFetch,WebSearch,Task"
cat <<EOF

[serve] stack is up (session=$SESS). Launch Claude Code so inference -> Lemonade proxy
        and tool calls -> AXIS (DefenseClaw-governed, sandboxed, audited):

  ANTHROPIC_BASE_URL="http://127.0.0.1:$PROXY_PORT" \\
  ANTHROPIC_AUTH_TOKEN="lemonade-local" \\
  ANTHROPIC_DEFAULT_OPUS_MODEL="$LEMON_MODEL" \\
  ANTHROPIC_DEFAULT_SONNET_MODEL="$LEMON_MODEL" \\
  ANTHROPIC_DEFAULT_HAIKU_MODEL="$LEMON_MODEL" \\
    claude --mcp-config "$MCP_JSON" \\
      --allowedTools "mcp__axis__run" \\
      --disallowedTools "$DISALLOW"

  audit/JSONL: $SINK    stop the stack: bash platforms/halo/serve.sh stop
EOF
