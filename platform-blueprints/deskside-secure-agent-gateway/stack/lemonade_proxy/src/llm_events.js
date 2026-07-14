// Copyright © Advanced Micro Devices, Inc., or its affiliates.
//
// SPDX-License-Identifier: MIT

// Splunk-HEC event builder + local sink for the INFERENCE plane.
//
// Same shipping contract as the connector's splunk_events.js (best-effort HEC
// POST that can never break the request path, plus a local JSONL sink), but a
// distinct sourcetype (axis:llm) into the SAME index (axis) so tool-plane
// (axis.toolcall) and inference-plane (llm.request) events sit side by side and
// correlate by identity.session.
//
// Content: prompt/completion text is emitted when the caller passes it
// (promptContent/completionContent). server.js includes it by default, redacted
// (see redact.js; LLM_CAPTURE_CONTENT=off for metadata only, or
// GLASSBOX_ALLOW_RAW_LLM_CONTENT=true for raw text). Token/char counts and the
// DefenseClaw verdicts (findings/severity) are always included.
//
//   llm.session_start { event, time, identity, policy{id,source} }
//   llm.request       { event, time, identity, policy, request{...}, decision,
//                       result{...}, routing{...}, defenseclaw_request{...},
//                       defenseclaw_response{...} }
//   llm.session_end   { event, time, identity }
//
// The routing block is the vLLM Semantic Router decision (see router.js): which
// tier served the call (local Lemonade vs frontier gateway), the router's
// selected model + complexity signal, and whether the router was reachable. It
// is null on a plain passthrough build (router disabled and never consulted).

import { appendFile } from "node:fs/promises";

import { otelEnvelope, genAiAttributes } from "./otel.js";
import { newSpanId } from "./trace.js";

const SOURCETYPE = "axis:llm";
const INDEX = "axis";

export class LlmEventSink {
  constructor({ sinkPath, hecUrl, hecToken, fetchImpl, otlp } = {}) {
    this.sinkPath = sinkPath || null;
    this.hecUrl = hecUrl ? hecUrl.replace(/\/+$/, "") : null;
    this.hecToken = hecToken || "fake-token";
    this.fetch = fetchImpl || globalThis.fetch;
    // Optional additive OTLP span export to a local collector (see otlp.js). HEC
    // stays the audit source of truth; this is a second consumer of the record.
    this.otlp = otlp || null;
  }

  async emit(event) {
    if (this.sinkPath) {
      await appendFile(this.sinkPath, JSON.stringify(event) + "\n");
    }
    if (this.hecUrl) {
      await this.#postHec(event).catch(() => {});
    }
    if (this.otlp) {
      await this.otlp.export(event).catch(() => {});
    }
    return event;
  }

  async #postHec(event) {
    const envelope = { time: event.time, sourcetype: SOURCETYPE, index: INDEX, event };
    await this.fetch(`${this.hecUrl}/services/collector/event`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Splunk ${this.hecToken}`,
      },
      body: JSON.stringify(envelope),
    });
  }
}

function nowEpoch() {
  return Date.now() / 1000;
}

function policyBlock(identity) {
  return { id: identity.policyId, source: identity.policySource };
}

function dcBlock(v) {
  if (!v) return null;
  return {
    action: v.decision,
    severity: v.severity,
    findings: v.findings,
    would_block: v.wouldBlock,
    reachable: v.reachable,
  };
}

/** The vLLM Semantic Router decision, shaped for Splunk. `upstream` is the base
 *  URL the proxy actually forwarded to (local Lemonade or the frontier gateway). */
function routingBlock(r) {
  if (!r) return null;
  return {
    enabled: Boolean(r.enabled),
    reachable: Boolean(r.reachable),
    decision: r.decision ?? null,
    complexity: r.complexity ?? null,
    selected_model: r.selectedModel ?? null,
    tier: r.tier ?? null,
    upstream: r.upstream ?? null,
    classify_ms: r.classifyMs ?? null,
  };
}

export function buildLlmSessionStart(identity) {
  return {
    event: "llm.session_start",
    time: nowEpoch(),
    ...otelEnvelope({ identity, trace: null, spanId: null, parentSpanId: null }),
    identity: identity.identityBlock(),
    policy: policyBlock(identity),
  };
}

export function buildLlmSessionEnd(identity) {
  return {
    event: "llm.session_end",
    time: nowEpoch(),
    ...otelEnvelope({ identity, trace: null, spanId: null, parentSpanId: null }),
    identity: identity.identityBlock(),
  };
}

/** One event per LLM call through the proxy.
 *  `decision` is the proxy's final disposition:
 *    allow   — forwarded and completed (upstream status < 400)
 *    block   — DefenseClaw blocked it in action mode (upstream never called)
 *    unknown — upstream error / no status observed */
export function buildLlmRequest({
  identity,
  seq,
  model,
  requestedModel,
  endpoint,
  stream,
  messages,
  promptChars,
  decision,
  result,
  routing,
  defenseclawRequest,
  defenseclawResponse,
  trace,
  gpu,
  promptContent = null,
  completionContent = null,
  contentRedacted = true,
}) {
  // Each LLM call is its own span, parented to the turn's root span.
  const spanId = newSpanId();
  const tier = routing?.tier ?? "local";
  const provider = tier === "frontier" ? "frontier" : "lemonade";
  const executionLocation = tier === "frontier" ? "cloud" : "deskside";
  return {
    event: "llm.request",
    time: nowEpoch(),
    ...otelEnvelope({
      identity,
      trace,
      spanId,
      parentSpanId: trace?.root_span_id ?? null,
    }),
    attributes: {
      ...genAiAttributes({
        requestedModel: requestedModel ?? model,
        servedModel: model,
        provider,
        executionLocation,
        inputTokens: result?.promptTokens ?? null,
        outputTokens: result?.completionTokens ?? null,
        stopReason: result?.stopReason ?? null,
      }),
      "axis.turn": trace?.turn ?? null,
    },
    identity: identity.identityBlock(),
    policy: policyBlock(identity),
    request: {
      seq,
      model,
      endpoint,
      stream: Boolean(stream),
      messages: messages ?? null,
      prompt_chars: promptChars ?? null,
      ...(promptContent != null ? { [contentRedacted ? "prompt_redacted" : "prompt_text"]: promptContent } : {}),
    },
    decision,
    routing: routingBlock(routing),
    // GPU consumption for LOCAL inference (null on frontier / when unavailable).
    gpu: gpu ?? null,
    result: result
      ? {
          status: result.status ?? null,
          duration_ms: result.durationMs ?? null,
          prompt_tokens: result.promptTokens ?? null,
          completion_tokens: result.completionTokens ?? null,
          completion_chars: result.completionChars ?? null,
          stop_reason: result.stopReason ?? null,
          ...(completionContent != null ? { [contentRedacted ? "completion_redacted" : "completion_text"]: completionContent } : {}),
        }
      : {
          status: null,
          duration_ms: null,
          prompt_tokens: null,
          completion_tokens: null,
          completion_chars: null,
          stop_reason: null,
        },
    defenseclaw_request: dcBlock(defenseclawRequest),
    defenseclaw_response: dcBlock(defenseclawResponse),
  };
}
