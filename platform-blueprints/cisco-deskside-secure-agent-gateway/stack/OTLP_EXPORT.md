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
governance. Each control span is enriched from the DefenseClaw verdict:
`agent_control.confidence` (score), `agent_control.control_id` plus
`defenseclaw.rule_ids`/`finding_titles`/`tags` (which rule fired),
`agent_control.check_stage`/`applies_to`/`agent_control.agent_name`, and
`defenseclaw.raw_action`/`mode` (the would-block decision in observe mode). Rule
`evidence` is deliberately not emitted — it can contain the matched secret.

**Input/output text.** The `execute_tool` span always carries the run command as input
(`gen_ai.input.messages`, from the redacted argv). When `LLM_CAPTURE_CONTENT=on`, the
inference plane also records the prompt and completion in the event `content` block and
the tool plane records the tool's stdout/stderr; the exporters map them to
`gen_ai.input.messages`/`output.messages` on the `chat` and `execute_tool` spans, and the
`invoke_agent` root carries the turn's first prompt + last completion so the trace shows
input/output. One switch (`LLM_CAPTURE_CONTENT`) governs both planes.

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
| `LLM_CAPTURE_CONTENT` | off | capture prompt/completion (inference) and tool stdout/stderr (tool plane) into the event `content` block; the exporters map it to `gen_ai.input.messages`/`output.messages` so it renders as span + trace input/output in AO |
| `LLM_CAPTURE_MAX_CHARS` | 8192 | truncate captured prompt/completion text to this length |
| `AXIS_AGENT_NAME` | `deskside-coding-agent` | agent identity on every span this box emits, as `gen_ai.agent.name` (AO's mapped agent field) and `agent.name` (a `user_metadata` facet); set once per deployment (e.g. in `serve.sh`) |
| `AXIS_USER_METADATA` | unset | JSON object (team/department/cost_center/…) whose keys are emitted as individual span attributes; AO's `otel_v2` lifts each into `user_metadata`. `enduser.id` is auto-added from the resolved user, and `llm.time_to_first_token_ms` from the local upstream (llama.cpp prompt-eval time) when reported |

## Trace sharing and DefenseClaw

The producers already share one `trace_id` per turn across both planes via
`AXIS_TRACE_STATE`. `AXIS_TRACE_PROPAGATION=on` also forwards that turn's
`traceparent` on the DefenseClaw consult, so DefenseClaw can correlate its telemetry
by `trace_id`.

DefenseClaw's latest gateway does emit its own guardrail span on the `/inspect/*` lane
(`span.guardrail.apply`), but it does not land as a control span on this trace, for three
reasons: (1) the gateway exports telemetry only when a v8 `observability.destinations[]`
OTLP entry is configured (off by default; our minimal `policy.yaml` records to local
SQLite only); (2) the inspect span is created as a fresh root — the inbound `traceparent`
is read for audit correlation but deliberately not used as the OTel parent on REST routes
(only the hook/notify loopback routes span-parent it); (3) `span.guardrail.apply` is in
DefenseClaw's `local-observability-v1` profile only, not `galileo-rich-v2`, and DefenseClaw
has no `agent_control.*`/`galileo.span.kind=control` concept, so it would not classify as
an AO control span even if exported and parented. Fixing (1) is config on our side; (2)
and (3) are DefenseClaw-side changes. Until then `AXIS_OTLP_CONTROL_SPANS=on` (the
producers derive the control span) is the correct path — it is the only source of an
AO-classifiable, on-trace control span, and it carries the DefenseClaw verdict enrichment
described above.
