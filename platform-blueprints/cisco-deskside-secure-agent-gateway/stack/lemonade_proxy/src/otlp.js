// Copyright © Advanced Micro Devices, Inc., or its affiliates.
//
// SPDX-License-Identifier: MIT

// Additive OTLP/JSON span exporter (Cisco telemetry delta #4) — INFERENCE plane.
//
// The llm.request events this plane emits already carry an OpenTelemetry-shaped
// envelope (trace_id/span_id/parent_span_id, resource, gen_ai.* attributes) plus
// the gpu/routing blocks and the DefenseClaw verdicts. This module turns the same
// event into OTLP spans and POSTs them to a local OTel collector, so a run reaches
// Splunk AO / Galileo without a downstream translator.
//
// Additive and opt-in: nothing runs unless a collector endpoint is configured via
// OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, OTEL_EXPORTER_OTLP_ENDPOINT, or
// AXIS_OTLP_ENDPOINT. HEC stays the audit source of truth; this is a second
// consumer of the same records. No OpenTelemetry SDK dependency: OTLP/JSON is built
// by hand. trace/span ids are already 32/16 lowercase hex, which is the OTLP/JSON id
// encoding, so they pass through unchanged.
//
// Spans per turn (this plane is the trace authority, so it emits the root):
//   invoke_agent      root, emitted once per trace_id
//   chat <model>      one per llm.request, child of the root; gen_ai/gpu/tokenomics
//   control:llm_call  DefenseClaw prompt/completion guardrail spans (leaf siblings),
//                     derived from the inline verdict. Turn off with
//                     AXIS_OTLP_CONTROL_SPANS=off once DefenseClaw emits its own.

import { newSpanId } from "./trace.js";

const SCOPE_NAME = "axis-telemetry";
const KIND_INTERNAL = 1;
const KIND_CLIENT = 3;
const STATUS_UNSET = 0;
const STATUS_ERROR = 2;
const MS_TO_NS = 1_000_000n;

/** The collector traces endpoint from the environment, or null when the exporter
 *  should stay off. */
export function otlpTracesEndpoint(env = process.env) {
  const explicit = (env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || "").trim();
  if (explicit) return explicit;
  const base = (env.OTEL_EXPORTER_OTLP_ENDPOINT || env.AXIS_OTLP_ENDPOINT || "").trim();
  if (!base) return null;
  return `${base.replace(/\/+$/, "")}/v1/traces`;
}

/** Epoch seconds -> OTLP unixNano string (events carry millisecond precision). */
function toNano(seconds) {
  const ms = Math.round((Number(seconds) || 0) * 1000);
  return (BigInt(ms) * MS_TO_NS).toString();
}

/** One OTLP AnyValue from a JS scalar or array. */
function anyValue(value) {
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) return { arrayValue: { values: value.map(anyValue) } };
  return { stringValue: String(value) };
}

/** A flat attribute map -> OTLP KeyValue[], dropping null/undefined entries. */
function toKeyValues(map) {
  const out = [];
  for (const [key, value] of Object.entries(map || {})) {
    if (value === null || value === undefined) continue;
    out.push({ key, value: anyValue(value) });
  }
  return out;
}

function span({ traceId, spanId, parentSpanId, name, kind, startNano, endNano, attributes, statusCode }) {
  return {
    traceId,
    spanId,
    parentSpanId: parentSpanId || "",
    name,
    kind,
    startTimeUnixNano: startNano,
    endTimeUnixNano: endNano,
    attributes: toKeyValues(attributes),
    status: { code: statusCode || STATUS_UNSET },
  };
}

/** Map a DefenseClaw verdict action onto a control action. galileo_core has no
 *  "allow", so an allow becomes "observe"; a block/deny becomes "deny". */
function controlAction(action) {
  const a = String(action || "").toLowerCase();
  if (a === "block" || a === "deny") return "deny";
  if (a === "steer") return "steer";
  return "observe";
}

/** The spans for one llm.request event: the root (once per trace), the chat span,
 *  and the derived DefenseClaw control spans. */
function llmSpans(event, rootState, { deriveControlSpans, emitRoot, agentName, userMetadata }) {
  const traceId = event.trace_id;
  const rootId = event.parent_span_id; // the turn root span id
  const chatId = event.span_id;
  if (!traceId || !chatId) return [];

  const attrs = event.attributes || {};
  const result = event.result || {};
  const gpu = event.gpu || {};
  // Content comes from the producer's opt-in `content` block (LLM_CAPTURE_CONTENT);
  // we map it to the OTel GenAI message arrays AO renders as span input/output.
  const content = event.content || {};
  const promptContent = content.prompt ?? null;
  const completionContent = content.completion ?? null;
  const session = event.identity?.session ?? null;
  const endNano = toNano(event.time);
  const durationMs = Number(result.duration_ms) || 0;
  const startNano = toNano((Number(event.time) || 0) - durationMs / 1000);
  const spans = [];
  // Agent name is configurable per box (AXIS_AGENT_NAME). The metadata bag is the
  // Operator-set AXIS_USER_METADATA plus the auto-resolved enduser.id and (when the
  // local upstream reports it) TTFT. AO's otel_v2 lifts individual span attributes into
  // user_metadata, so each dim is emitted as its own attribute (spread below), not
  // bundled into one JSON blob.
  const agent = agentName || "deskside-coding-agent";
  const meta = { ...(userMetadata || {}) };
  if (event.identity?.user) meta["enduser.id"] = event.identity.user;
  // Plain llm.* key (not gen_ai.*) so otel_v2 lifts it into user_metadata as a facet
  // tokenomics can read, rather than mapping it to a first-class gen_ai field.
  if (result.time_to_first_token_ms != null)
    meta["llm.time_to_first_token_ms"] = String(result.time_to_first_token_ms);
  // gen_ai.agent.name is consumed into AO's mapped agent field; expose agent.name too so
  // the agent identity also survives as a user_metadata facet.
  meta["agent.name"] = agent;

  // Root: emitted (and re-emitted) per event by the authority plane. Trace input is
  // the turn's first prompt; trace output tracks the latest completion. AO upserts by
  // the stable root span id, so re-emitting converges to first-prompt / last-completion.
  if (emitRoot && rootId) {
    if (!rootState.has(traceId)) rootState.set(traceId, { input: promptContent, startNano });
    const rs = rootState.get(traceId);
    spans.push(
      span({
        traceId,
        spanId: rootId,
        parentSpanId: "",
        name: "invoke_agent",
        kind: KIND_INTERNAL,
        startNano: rs.startNano,
        endNano,
        attributes: {
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.agent.name": agent,
          "gen_ai.conversation.id": session,
          ...meta,
          "axis.turn": attrs["axis.turn"] ?? null,
          "gen_ai.input.messages": rs.input
            ? JSON.stringify([{ role: "user", content: rs.input }])
            : null,
          "gen_ai.output.messages": completionContent
            ? JSON.stringify([{ role: "assistant", content: completionContent }])
            : null,
        },
      }),
    );
  }

  // chat: the LLM call, with gen_ai + gpu + tokenomics + inline verdict summary.
  const model = attrs["gen_ai.response.model"] || attrs["gen_ai.request.model"] || "";
  const statusCode =
    (Number(result.status) || 0) >= 400 || event.decision === "block" ? STATUS_ERROR : STATUS_UNSET;
  spans.push(
    span({
      traceId,
      spanId: chatId,
      parentSpanId: rootId,
      name: `chat ${model}`.trim(),
      kind: KIND_CLIENT,
      startNano,
      endNano,
      statusCode,
      attributes: {
        ...attrs,
        "gen_ai.conversation.id": session,
        "gen_ai.agent.name": agent,
        ...meta,
        "gpu.energy_joules": gpu.energy_joules ?? null,
        "gpu.power_avg_w": gpu.power_avg_w ?? null,
        "tokenomics.input_tokens": attrs["gen_ai.usage.input_tokens"] ?? null,
        "tokenomics.output_tokens": attrs["gen_ai.usage.output_tokens"] ?? null,
        "tokenomics.local.energy_joules": gpu.energy_joules ?? null,
        "tokenomics.execution_location": attrs["execution_location"] ?? null,
        "routing.tier": event.routing?.tier ?? null,
        "routing.selected_model": event.routing?.selected_model ?? null,
        "defenseclaw.request.action": event.defenseclaw_request?.action ?? null,
        "defenseclaw.request.severity": event.defenseclaw_request?.severity ?? null,
        "defenseclaw.response.action": event.defenseclaw_response?.action ?? null,
        "defenseclaw.response.severity": event.defenseclaw_response?.severity ?? null,
        "gen_ai.input.messages": promptContent
          ? JSON.stringify([{ role: "user", content: promptContent }])
          : null,
        "gen_ai.output.messages": completionContent
          ? JSON.stringify([{ role: "assistant", content: completionContent }])
          : null,
      },
    }),
  );

  // control spans: one per inline DefenseClaw verdict, leaf siblings of the chat
  // span, nudged just after its start so a consumer orders them adjacent.
  if (deriveControlSpans) {
    const stages = [
      ["pre", "defenseclaw:prompt", event.defenseclaw_request],
      ["post", "defenseclaw:completion", event.defenseclaw_response],
    ];
    let offset = 1;
    for (const [stage, controlName, verdict] of stages) {
      if (!verdict) continue;
      const at = (BigInt(startNano) + BigInt(offset) * MS_TO_NS).toString();
      const action = controlAction(verdict.action);
      const rules = Array.isArray(verdict.rules) ? verdict.rules : [];
      const ruleIds = rules.map((r) => r.id).filter(Boolean);
      const titles = rules.map((r) => r.title).filter(Boolean);
      const tags = [...new Set(rules.flatMap((r) => (Array.isArray(r.tags) ? r.tags : [])))];
      spans.push(
        span({
          traceId,
          spanId: newSpanId(),
          parentSpanId: rootId,
          name: `control:llm_call:${stage}`,
          kind: KIND_INTERNAL,
          startNano: at,
          endNano: at,
          attributes: {
            "galileo.span.kind": "control",
            "gen_ai.operation.name": "control",
            "gen_ai.conversation.id": session,
            "agent_control.action": action,
            "agent_control.control_name": controlName,
            "agent_control.evaluator_name": "DefenseClaw",
            "agent_control.stage": stage,
            "agent_control.check_stage": stage,
            "agent_control.applies_to": "llm_call",
            "agent_control.agent_name": agent,
            "agent_control.confidence": typeof verdict.confidence === "number" ? verdict.confidence : null,
            "agent_control.control_id": ruleIds[0] ?? null,
            "agent_control.matched": Boolean(verdict.would_block) || action !== "observe",
            "agent_control.metadata.target_span_id": chatId,
            "defenseclaw.action": verdict.action ?? null,
            "defenseclaw.severity": verdict.severity ?? null,
            "defenseclaw.raw_action": verdict.raw_action ?? null,
            "defenseclaw.mode": verdict.mode ?? null,
            "defenseclaw.rule_ids": ruleIds.length ? ruleIds.join(",") : null,
            "defenseclaw.finding_titles": titles.length ? titles.join("; ") : null,
            "defenseclaw.tags": tags.length ? tags.join(",") : null,
          },
        }),
      );
      offset += 1;
    }
  }

  return spans;
}

export class OtlpSpanExporter {
  constructor({ endpoint, fetchImpl, deriveControlSpans = true, emitRoot = true, agentName, userMetadata } = {}) {
    this.endpoint = endpoint || null;
    this.fetch = fetchImpl || globalThis.fetch;
    this.deriveControlSpans = deriveControlSpans;
    this.emitRoot = emitRoot;
    this.agentName = agentName;
    this.userMetadata = userMetadata || {};
    this.rootState = new Map();
  }

  get enabled() {
    return Boolean(this.endpoint);
  }

  /** Map one event to an OTLP ExportTraceServiceRequest, or null when it has no
   *  spans (session-lifecycle events). */
  requestFor(event) {
    if (!event || event.event !== "llm.request") return null;
    const spans = llmSpans(event, this.rootState, {
      deriveControlSpans: this.deriveControlSpans,
      emitRoot: this.emitRoot,
      agentName: this.agentName,
      userMetadata: this.userMetadata,
    });
    if (!spans.length) return null;
    return {
      resourceSpans: [
        {
          resource: { attributes: toKeyValues(event.resource) },
          scopeSpans: [{ scope: { name: SCOPE_NAME }, spans }],
        },
      ],
    };
  }

  /** Best-effort export. Never throws: a collector hiccup must not break the
   *  request path (mirrors the HEC sink). Returns the request that was sent, or
   *  null when nothing was exported (useful for tests). */
  async export(event) {
    if (!this.enabled) return null;
    const request = this.requestFor(event);
    if (!request) return null;
    try {
      await this.fetch(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
    } catch {
      /* best-effort: OTLP export can never break inference */
    }
    return request;
  }
}

/** Build an exporter from the environment, or null when no collector is configured
 *  (the exporter stays off). */
export function otlpFromEnv(env = process.env, { emitRoot = true, fetchImpl } = {}) {
  const endpoint = otlpTracesEndpoint(env);
  if (!endpoint) return null;
  // AXIS_USER_METADATA is an operator-set JSON bag (team/department/cost_center/...);
  // AXIS_AGENT_NAME names the agent for every span this box emits.
  let userMetadata = {};
  try {
    userMetadata = env.AXIS_USER_METADATA ? JSON.parse(env.AXIS_USER_METADATA) : {};
  } catch {
    userMetadata = {};
  }
  return new OtlpSpanExporter({
    endpoint,
    fetchImpl,
    emitRoot,
    deriveControlSpans: env.AXIS_OTLP_CONTROL_SPANS !== "off",
    agentName: (env.AXIS_AGENT_NAME || "").trim() || "deskside-coding-agent",
    userMetadata,
  });
}
