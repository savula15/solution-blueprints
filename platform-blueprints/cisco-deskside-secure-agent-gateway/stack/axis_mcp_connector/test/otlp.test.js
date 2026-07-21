// Copyright © Advanced Micro Devices, Inc., or its affiliates.
//
// SPDX-License-Identifier: MIT

// Additive OTLP export contract (TOOL plane). Runs the real axis.toolcall builder
// into the real exporter and asserts on the produced OTLP spans.

import { test } from "node:test";
import assert from "node:assert/strict";

import { OtlpSpanExporter, otlpTracesEndpoint } from "../src/otlp.js";
import { buildToolCall, buildSessionStart } from "../src/splunk_events.js";

const identity = {
  tenant: "acme",
  deviceId: "dev-1",
  policyId: "pol-1",
  policySource: "test",
  identityBlock: () => ({ session: "sess-1", user: "u", tenant: "acme", device_id: "dev-1" }),
};

// The tool plane READS the trace the inference plane wrote; it never owns the root.
const trace = { trace_id: "a".repeat(32), root_span_id: "b".repeat(16), turn: 1 };

function toolEvent(overrides = {}) {
  return buildToolCall({
    identity,
    seq: 1,
    argv: ["bash", "-c", "echo hi"],
    argvRedacted: ["bash", "-c", "echo hi"],
    decision: "allow",
    result: { code: 0, durationMs: 12, timedOut: false },
    defenseclaw: { decision: "allow", severity: "NONE", findings: [], wouldBlock: false, reachable: true },
    trace,
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
  return undefined;
}

test("otlpTracesEndpoint resolves from env, or stays off", () => {
  assert.equal(otlpTracesEndpoint({}), null);
  assert.equal(otlpTracesEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318" }), "http://c:4318/v1/traces");
});

test("an allowed tool call maps to execute_tool + admission control, no root", () => {
  const exporter = new OtlpSpanExporter({ endpoint: "http://c/v1/traces" });
  const spans = spansOf(exporter.requestFor(toolEvent()));

  assert.ok(!spans.some((s) => s.name === "invoke_agent"), "tool plane never emits the root");

  const tool = spans.find((s) => s.name.startsWith("execute_tool"));
  assert.equal(tool.traceId, trace.trace_id);
  assert.equal(tool.parentSpanId, trace.root_span_id);
  assert.equal(attr(tool, "gen_ai.operation.name"), "execute_tool");
  assert.equal(attr(tool, "gen_ai.tool.name"), "run");
  assert.equal(attr(tool, "axis.decision"), "allow");
  assert.equal(attr(tool, "axis.exit"), 0);
  assert.equal(tool.status.code, 0);

  const control = spans.find((s) => s.name === "control:tool_call:pre");
  assert.equal(attr(control, "galileo.span.kind"), "control");
  assert.equal(attr(control, "agent_control.action"), "observe");
  assert.equal(attr(control, "agent_control.evaluator_name"), "DefenseClaw");
});

test("execute_tool carries the command as input (from the redacted argv)", () => {
  const exporter = new OtlpSpanExporter({ endpoint: "http://c/v1/traces" });
  const tool = spansOf(exporter.requestFor(toolEvent())).find((s) => s.name.startsWith("execute_tool"));
  assert.equal(attr(tool, "gen_ai.tool.call.arguments"), "bash -c echo hi");
  assert.deepEqual(JSON.parse(attr(tool, "gen_ai.input.messages")), [{ role: "user", content: "bash -c echo hi" }]);
  // No output shipped unless content capture is on.
  assert.equal(attr(tool, "gen_ai.tool.call.result"), undefined);
  assert.equal(attr(tool, "gen_ai.output.messages"), undefined);
});

test("execute_tool carries stdout/stderr as output when content capture is on", () => {
  const exporter = new OtlpSpanExporter({ endpoint: "http://c/v1/traces" });
  const event = toolEvent({
    capture: true,
    result: { code: 0, durationMs: 12, timedOut: false, stdout: "ROCM_OK", stderr: "" },
  });
  const tool = spansOf(exporter.requestFor(event)).find((s) => s.name.startsWith("execute_tool"));
  assert.equal(attr(tool, "gen_ai.tool.call.result"), "ROCM_OK");
  assert.deepEqual(JSON.parse(attr(tool, "gen_ai.output.messages")), [{ role: "assistant", content: "ROCM_OK" }]);
});

test("a sandbox deny is a failed execute_tool, not a second control span", () => {
  const exporter = new OtlpSpanExporter({ endpoint: "http://c/v1/traces" });
  const event = toolEvent({
    decision: "deny",
    result: { code: 1, durationMs: 5, timedOut: false },
    defenseclaw: { decision: "allow", severity: "NONE", findings: [], wouldBlock: false, reachable: true },
  });
  const spans = spansOf(exporter.requestFor(event));

  const tool = spans.find((s) => s.name.startsWith("execute_tool"));
  assert.equal(tool.status.code, 2);
  assert.equal(attr(tool, "axis.decision"), "deny");
  assert.equal(attr(tool, "axis.exit"), 1);

  // DefenseClaw admitted it, so the one control span is an observe, not a deny.
  const controls = spans.filter((s) => s.name.startsWith("control:"));
  assert.equal(controls.length, 1);
  assert.equal(attr(controls[0], "agent_control.action"), "observe");
});

test("a DefenseClaw-blocked tool call yields a deny control span", () => {
  const exporter = new OtlpSpanExporter({ endpoint: "http://c/v1/traces" });
  const event = toolEvent({
    decision: "block",
    result: null,
    defenseclaw: { decision: "block", severity: "HIGH", findings: ["PATH-SSH-KEY"], wouldBlock: true, reachable: true },
  });
  const spans = spansOf(exporter.requestFor(event));
  const control = spans.find((s) => s.name === "control:tool_call:pre");
  assert.equal(attr(control, "agent_control.action"), "deny");
  assert.equal(attr(control, "agent_control.matched"), true);
});

test("AXIS_OTLP_CONTROL_SPANS=off drops the derived control span", () => {
  const exporter = new OtlpSpanExporter({ endpoint: "http://c/v1/traces", deriveControlSpans: false });
  const spans = spansOf(exporter.requestFor(toolEvent()));
  assert.equal(spans.filter((s) => s.name.startsWith("control:")).length, 0);
  assert.equal(spans.length, 1);
});

test("session-lifecycle events produce no spans", () => {
  const exporter = new OtlpSpanExporter({ endpoint: "http://c/v1/traces" });
  assert.equal(exporter.requestFor(buildSessionStart(identity)), null);
});

test("execute_tool carries the configured agent name + per-dim user_metadata attributes", () => {
  const exporter = new OtlpSpanExporter({
    endpoint: "http://c/v1/traces",
    agentName: "cc-deskside",
    userMetadata: { "organization.team": "payments" },
  });
  const tool = spansOf(exporter.requestFor(toolEvent())).find((s) => s.name.startsWith("execute_tool"));
  assert.equal(attr(tool, "gen_ai.agent.name"), "cc-deskside");
  assert.equal(attr(tool, "agent.name"), "cc-deskside");
  assert.equal(attr(tool, "organization.team"), "payments");
  assert.equal(attr(tool, "enduser.id"), "u");
  assert.equal(attr(tool, "metadata"), undefined);
});

test("export posts OTLP/JSON and never throws on failure", async () => {
  let captured = null;
  const okFetch = async (url, opts) => {
    captured = { url, body: JSON.parse(opts.body) };
    return { ok: true, status: 200, text: async () => "" };
  };
  const exporter = new OtlpSpanExporter({ endpoint: "http://c/v1/traces", fetchImpl: okFetch });
  await exporter.export(toolEvent());
  assert.equal(captured.url, "http://c/v1/traces");
  assert.ok(captured.body.resourceSpans[0].scopeSpans[0].spans.length > 0);

  const throwingFetch = async () => {
    throw new Error("collector down");
  };
  const resilient = new OtlpSpanExporter({ endpoint: "http://c/v1/traces", fetchImpl: throwingFetch });
  await assert.doesNotReject(resilient.export(toolEvent()));
});
