// Copyright © Advanced Micro Devices, Inc., or its affiliates.
//
// SPDX-License-Identifier: MIT

// Additive OTLP export contract (INFERENCE plane). Runs the real llm.request
// builder into the real exporter and asserts on the produced OTLP spans.

import { test } from "node:test";
import assert from "node:assert/strict";

import { OtlpSpanExporter, otlpTracesEndpoint } from "../src/otlp.js";
import { buildLlmRequest, buildLlmSessionStart } from "../src/llm_events.js";

const identity = {
  tenant: "acme",
  deviceId: "dev-1",
  policyId: "pol-1",
  policySource: "test",
  identityBlock: () => ({ session: "sess-1", user: "u", tenant: "acme", device_id: "dev-1" }),
};

const trace = { trace_id: "a".repeat(32), root_span_id: "b".repeat(16), turn: 2 };

function llmEvent(overrides = {}) {
  return buildLlmRequest({
    identity,
    seq: 1,
    model: "Qwen3-8B",
    requestedModel: "Qwen3-8B",
    endpoint: "/v1/messages",
    stream: false,
    messages: 2,
    promptChars: 100,
    decision: "allow",
    result: { status: 200, durationMs: 1200, promptTokens: 50, completionTokens: 20, completionChars: 80, stopReason: "end_turn" },
    routing: { enabled: true, reachable: true, tier: "local", selectedModel: "Qwen3-8B", decision: "local" },
    defenseclawRequest: { decision: "allow", severity: "NONE", findings: [], wouldBlock: false, reachable: true },
    defenseclawResponse: { decision: "allow", severity: "NONE", findings: [], wouldBlock: false, reachable: true },
    trace,
    gpu: { energy_joules: 12.5, power_avg_w: 45.2 },
    ...overrides,
  });
}

function spansOf(request) {
  return request.resourceSpans[0].scopeSpans[0].spans;
}

function attr(span, key) {
  const kv = span.attributes.find((a) => a.key === key);
  if (!kv) return undefined;
  const v = kv.value;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.arrayValue !== undefined) return v.arrayValue.values;
  return undefined;
}

test("otlpTracesEndpoint resolves from env, or stays off", () => {
  assert.equal(otlpTracesEndpoint({}), null);
  assert.equal(otlpTracesEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318" }), "http://c:4318/v1/traces");
  assert.equal(otlpTracesEndpoint({ AXIS_OTLP_ENDPOINT: "http://c:4318/" }), "http://c:4318/v1/traces");
  assert.equal(
    otlpTracesEndpoint({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://c:4318/v1/traces" }),
    "http://c:4318/v1/traces",
  );
});

test("an llm.request maps to root + chat + two control spans on one trace", () => {
  const exporter = new OtlpSpanExporter({ endpoint: "http://c/v1/traces" });
  const spans = spansOf(exporter.requestFor(llmEvent()));

  const root = spans.find((s) => s.name === "invoke_agent");
  const chat = spans.find((s) => s.name.startsWith("chat"));
  const controls = spans.filter((s) => s.name.startsWith("control:llm_call"));

  assert.ok(root, "root emitted");
  assert.equal(root.parentSpanId, "");
  assert.equal(root.spanId, trace.root_span_id);

  assert.equal(chat.traceId, trace.trace_id);
  assert.equal(chat.parentSpanId, trace.root_span_id);
  assert.equal(attr(chat, "gen_ai.usage.input_tokens"), 50);
  assert.equal(attr(chat, "tokenomics.input_tokens"), 50);
  assert.equal(attr(chat, "gpu.energy_joules"), 12.5);
  assert.equal(attr(chat, "execution_location"), "deskside");

  assert.equal(controls.length, 2);
  for (const c of controls) {
    assert.equal(attr(c, "galileo.span.kind"), "control");
    assert.equal(attr(c, "agent_control.evaluator_name"), "DefenseClaw");
    assert.equal(attr(c, "agent_control.action"), "observe");
  }
});

test("chat span carries gen_ai input/output messages when the event has content", () => {
  const exporter = new OtlpSpanExporter({ endpoint: "http://c/v1/traces" });
  const spans = spansOf(exporter.requestFor(llmEvent({ content: { prompt: "hello there", completion: "hi back" } })));
  const chat = spans.find((s) => s.name.startsWith("chat"));
  assert.deepEqual(JSON.parse(attr(chat, "gen_ai.input.messages")), [{ role: "user", content: "hello there" }]);
  assert.deepEqual(JSON.parse(attr(chat, "gen_ai.output.messages")), [{ role: "assistant", content: "hi back" }]);
});

test("chat span omits messages when the event has no content", () => {
  const exporter = new OtlpSpanExporter({ endpoint: "http://c/v1/traces" });
  const spans = spansOf(exporter.requestFor(llmEvent()));
  const chat = spans.find((s) => s.name.startsWith("chat"));
  assert.equal(attr(chat, "gen_ai.input.messages"), undefined);
  assert.equal(attr(chat, "gen_ai.output.messages"), undefined);
});

test("root re-emits with first prompt as input and the latest completion as output", () => {
  const exporter = new OtlpSpanExporter({ endpoint: "http://c/v1/traces" });
  exporter.requestFor(llmEvent({ content: { prompt: "first prompt", completion: "first answer" } }));
  const spans = spansOf(exporter.requestFor(llmEvent({ content: { prompt: "second prompt", completion: "final answer" } })));
  const root = spans.find((s) => s.name === "invoke_agent");
  assert.ok(root, "root re-emitted on the trace's later events (upsert by stable span id)");
  assert.equal(root.spanId, trace.root_span_id);
  // input stays the turn's first prompt; output tracks the latest completion
  assert.deepEqual(JSON.parse(attr(root, "gen_ai.input.messages")), [{ role: "user", content: "first prompt" }]);
  assert.deepEqual(JSON.parse(attr(root, "gen_ai.output.messages")), [{ role: "assistant", content: "final answer" }]);
});

test("AXIS_OTLP_CONTROL_SPANS=off drops the derived control spans", () => {
  const exporter = new OtlpSpanExporter({ endpoint: "http://c/v1/traces", deriveControlSpans: false });
  const spans = spansOf(exporter.requestFor(llmEvent()));
  assert.equal(spans.filter((s) => s.name.startsWith("control:")).length, 0);
});

test("a blocked prompt is an error chat span with a deny control span", () => {
  const exporter = new OtlpSpanExporter({ endpoint: "http://c/v1/traces" });
  const event = llmEvent({
    decision: "block",
    result: { status: 403, durationMs: 5 },
    defenseclawRequest: { decision: "block", severity: "HIGH", findings: ["X"], wouldBlock: true, reachable: true },
    defenseclawResponse: null,
  });
  const spans = spansOf(exporter.requestFor(event));
  const chat = spans.find((s) => s.name.startsWith("chat"));
  const pre = spans.find((s) => s.name === "control:llm_call:pre");
  assert.equal(chat.status.code, 2);
  assert.equal(attr(pre, "agent_control.action"), "deny");
  assert.equal(attr(pre, "agent_control.matched"), true);
  assert.ok(!spans.some((s) => s.name === "control:llm_call:post"));
});

test("session-lifecycle events produce no spans", () => {
  const exporter = new OtlpSpanExporter({ endpoint: "http://c/v1/traces" });
  assert.equal(exporter.requestFor(buildLlmSessionStart(identity)), null);
});

test("export posts OTLP/JSON to the collector and never throws on failure", async () => {
  let captured = null;
  const okFetch = async (url, opts) => {
    captured = { url, body: JSON.parse(opts.body) };
    return { ok: true, status: 200, text: async () => "" };
  };
  const exporter = new OtlpSpanExporter({ endpoint: "http://c/v1/traces", fetchImpl: okFetch });
  await exporter.export(llmEvent());
  assert.equal(captured.url, "http://c/v1/traces");
  assert.ok(captured.body.resourceSpans[0].scopeSpans[0].spans.length > 0);

  const throwingFetch = async () => {
    throw new Error("collector down");
  };
  const resilient = new OtlpSpanExporter({ endpoint: "http://c/v1/traces", fetchImpl: throwingFetch });
  await assert.doesNotReject(resilient.export(llmEvent()));
});

test("a disabled exporter (no endpoint) exports nothing", async () => {
  const exporter = new OtlpSpanExporter({});
  assert.equal(exporter.enabled, false);
  assert.equal(await exporter.export(llmEvent()), null);
});
