// Copyright © Advanced Micro Devices, Inc., or its affiliates.
//
// SPDX-License-Identifier: MIT

// Additive OTLP/JSON span exporter (Cisco telemetry delta #4) — TOOL plane.
//
// The axis.toolcall events this connector emits already carry the OpenTelemetry
// envelope (trace_id/span_id/parent_span_id, resource, attributes) and the
// DefenseClaw verdict. This module turns the same event into OTLP spans and POSTs
// them to a local OTel collector, so a run reaches Splunk AO / Galileo without a
// downstream translator.
//
// Additive and opt-in: nothing runs unless a collector endpoint is configured via
// OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, OTEL_EXPORTER_OTLP_ENDPOINT, or
// AXIS_OTLP_ENDPOINT. HEC stays the audit source of truth. No OpenTelemetry SDK
// dependency: OTLP/JSON is built by hand; ids are already 32/16 lowercase hex.
//
// Spans per tool call (the inference plane owns the root, so this plane never emits
// it; the execute_tool span parents onto the shared root_span_id):
//   execute_tool <tool>       one per axis.toolcall; carries axis.decision + exit
//   control:tool_call:pre     DefenseClaw admission span (leaf sibling), derived
//                             from the inline verdict. A sandbox refusal
//                             (decision=deny) is a tool outcome on execute_tool, not
//                             a control span. Turn off with AXIS_OTLP_CONTROL_SPANS=off.

import { newSpanId } from "./trace.js";

const SCOPE_NAME = "axis-telemetry";
const KIND_INTERNAL = 1;
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

function anyValue(value) {
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) return { arrayValue: { values: value.map(anyValue) } };
  return { stringValue: String(value) };
}

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

/** DefenseClaw verdict action -> control action (galileo_core has no "allow"). */
function controlAction(action) {
  const a = String(action || "").toLowerCase();
  if (a === "block" || a === "deny") return "deny";
  if (a === "steer") return "steer";
  return "observe";
}

/** The spans for one axis.toolcall event: the execute_tool span and the derived
 *  DefenseClaw admission control span. */
function toolSpans(event, { deriveControlSpans }) {
  const traceId = event.trace_id;
  const rootId = event.parent_span_id; // the turn root written by the inference plane
  const toolId = event.span_id;
  if (!traceId || !toolId) return [];

  const attrs = event.attributes || {};
  const result = event.result || {};
  const verdict = event.defenseclaw || null;
  const session = event.identity?.session ?? null;
  const endNano = toNano(event.time);
  const durationMs = Number(result.duration_ms) || 0;
  const startNano = toNano((Number(event.time) || 0) - durationMs / 1000);
  const exit = result.exit;
  // A non-zero exit (including a landlock/seccomp sandbox refusal, decision=deny)
  // is a tool-execution failure recorded on the span itself, not a control span.
  const statusCode =
    (typeof exit === "number" && exit !== 0) || event.decision === "deny" ? STATUS_ERROR : STATUS_UNSET;
  const spans = [];

  spans.push(
    span({
      traceId,
      spanId: toolId,
      parentSpanId: rootId,
      name: `execute_tool ${attrs["tool.name"] || "run"}`.trim(),
      kind: KIND_INTERNAL,
      startNano,
      endNano,
      statusCode,
      attributes: {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": attrs["tool.name"] || "run",
        "gen_ai.tool.type": "function",
        "gen_ai.conversation.id": session,
        "axis.turn": attrs["axis.turn"] ?? null,
        "axis.decision": event.decision ?? null,
        "axis.exit": typeof exit === "number" ? exit : null,
      },
    }),
  );

  // control span: the DefenseClaw admission verdict, a leaf sibling of the tool
  // span, nudged just after its start.
  if (deriveControlSpans && verdict) {
    const at = (BigInt(startNano) + MS_TO_NS).toString();
    const action = controlAction(verdict.action);
    spans.push(
      span({
        traceId,
        spanId: newSpanId(),
        parentSpanId: rootId,
        name: "control:tool_call:pre",
        kind: KIND_INTERNAL,
        startNano: at,
        endNano: at,
        attributes: {
          "galileo.span.kind": "control",
          "gen_ai.operation.name": "control",
          "gen_ai.conversation.id": session,
          "agent_control.action": action,
          "agent_control.control_name": "defenseclaw:tool-admission",
          "agent_control.evaluator_name": "DefenseClaw",
          "agent_control.stage": "pre",
          "agent_control.matched": Boolean(verdict.would_block) || action !== "observe",
          "agent_control.metadata.target_span_id": toolId,
          "axis.decision": event.decision ?? null,
          "defenseclaw.action": verdict.action ?? null,
          "defenseclaw.severity": verdict.severity ?? null,
        },
      }),
    );
  }

  return spans;
}

export class OtlpSpanExporter {
  constructor({ endpoint, fetchImpl, deriveControlSpans = true } = {}) {
    this.endpoint = endpoint || null;
    this.fetch = fetchImpl || globalThis.fetch;
    this.deriveControlSpans = deriveControlSpans;
  }

  get enabled() {
    return Boolean(this.endpoint);
  }

  /** Map one event to an OTLP ExportTraceServiceRequest, or null when it has no
   *  spans (session-lifecycle events). */
  requestFor(event) {
    if (!event || event.event !== "axis.toolcall") return null;
    const spans = toolSpans(event, { deriveControlSpans: this.deriveControlSpans });
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

  /** Best-effort export. Never throws (a collector hiccup must not break a tool
   *  call). Returns the request that was sent, or null when nothing was exported. */
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
      /* best-effort: OTLP export can never break a tool call */
    }
    return request;
  }
}

/** Build an exporter from the environment, or null when no collector is configured. */
export function otlpFromEnv(env = process.env, { fetchImpl } = {}) {
  const endpoint = otlpTracesEndpoint(env);
  if (!endpoint) return null;
  return new OtlpSpanExporter({
    endpoint,
    fetchImpl,
    deriveControlSpans: env.AXIS_OTLP_CONTROL_SPANS !== "off",
  });
}
