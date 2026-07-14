# Direct OTLP export (additive, opt-in)

The producers are HEC-first: every `llm.request` and `axis.toolcall` event carries
an OpenTelemetry-shaped envelope inside the event JSON, and HEC (or the local JSONL
sink) is the audit source of truth. This document describes the additive path that
also emits those same records as OTLP spans to a deskside OTel collector, so a run
reaches Splunk AO / Galileo without a downstream translator.

Nothing here changes the event schema (`schema_version` stays `1.0`) or the HEC
behavior. The exporter is off unless a collector endpoint is configured.

## What it emits

Both planes turn the event they already build into OTLP spans (`src/otlp.js`),
preserving the producer-owned `trace_id`/`span_id`/`parent_span_id` (already 32/16
lowercase hex, the OTLP/JSON id encoding). One turn:

```
invoke_agent                 (inference plane, the trace authority, emits the root once)
├── chat <model>             (llm.request: gen_ai.* + gpu.* + tokenomics.*)
├── control:llm_call:pre     (DefenseClaw prompt verdict)
├── control:llm_call:post    (DefenseClaw completion verdict)
├── execute_tool <tool>      (axis.toolcall: axis.decision + exit)
└── control:tool_call:pre    (DefenseClaw admission verdict)
```

A sandbox refusal (`decision=deny`) is a failed `execute_tool` span (`axis.decision`,
non-zero `axis.exit`), not a control span. Control spans use
`galileo.span.kind=control` + `agent_control.*` so Splunk AO classifies them as
governance.

## Enable it

Point both producers at the collector (unset leaves the exporter off):

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318   # collector base; /v1/traces is appended
# or a full endpoint:
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:4318/v1/traces
```

Run the deskside collector (see `otel-collector/config.yaml`):

```bash
export GALILEO_OTLP_ENDPOINT=https://api.galileo.ai/otel/traces
export GALILEO_API_KEY=...        # server-side only, never reaches the agent
export GALILEO_PROJECT=amd-deskside-demo
export GALILEO_LOG_STREAM=amd-glassbox
otelcol-contrib --config stack/otel-collector/config.yaml
```

### Automatic bring-up

`platforms/halo/run.sh` starts the collector for you when a Galileo endpoint is
configured. Export the egress settings, then run as usual:

```bash
export GALILEO_OTLP_ENDPOINT=https://<your-ao>/otel/v1/traces
export GALILEO_API_KEY=...  GALILEO_PROJECT=AMD-Deskside  GALILEO_LOG_STREAM=AMD-Deskside-Codex
bash platforms/halo/run.sh
```

When `GALILEO_OTLP_ENDPOINT` is set, the wrapper: installs + launches
`otel-collector/run-collector.sh` (downloads `otelcol-contrib` into `$HALO_TOOLS/bin`,
no sudo), exports `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318` and
`AXIS_TRACE_PROPAGATION=on` so both producers emit, and stops the collector on exit
(`artifacts/collector.log`). With the variable unset, the run is unchanged (HEC/JSONL
only, no collector). `setup.sh` does not touch the collector; it is fetched on first run.

## Flags

| Variable | Default | Effect |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` / `AXIS_OTLP_ENDPOINT` | unset | collector base URL; enables the exporter |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | unset | full traces endpoint (overrides the base) |
| `AXIS_OTLP_CONTROL_SPANS` | on | producers derive DefenseClaw control spans from the inline verdict; set `off` once DefenseClaw emits its own |
| `AXIS_TRACE_PROPAGATION` | off | forward the turn's W3C `traceparent` on the DefenseClaw consult |
| `LLM_CAPTURE_CONTENT` | on | include prompt/completion text on llm spans (`gen_ai.input.messages`/`output.messages`); `off` = metadata only |
| `GLASSBOX_ALLOW_RAW_LLM_CONTENT` | off | emit raw un-redacted prompt/completion instead of redacted (default is redacted via `redact.js`) |
| `LLM_CONTENT_MAX_CHARS` | 4000 | truncate captured prompt/completion text to this length |

## Trace sharing and DefenseClaw

The producers already share one `trace_id` per turn across both planes via
`AXIS_TRACE_STATE`. `AXIS_TRACE_PROPAGATION=on` also forwards that turn's
`traceparent` on the DefenseClaw consult, so DefenseClaw can correlate its telemetry
by `trace_id`.

For DefenseClaw to emit its own control spans as true children of this trace it must
span-parent the inbound `traceparent` on its `/inspect` and `/guardrail` routes
(today it does so only on its hook/notify routes). Until that lands, keep
`AXIS_OTLP_CONTROL_SPANS=on` so the producers emit the control spans.
