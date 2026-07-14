// Copyright © Advanced Micro Devices, Inc., or its affiliates.
//
// SPDX-License-Identifier: MIT

import { test } from "node:test";
import assert from "node:assert/strict";

import { redactText } from "../src/redact.js";

test("redactText scrubs common secrets and preserves surrounding prose", () => {
  const s =
    "email alice@acme.com, aws AKIAIOSFODNN7EXAMPLE, key sk-ABCDEFGHIJKLMNOPQRSTUVWX — here is the plan";
  const r = redactText(s);
  assert.ok(!r.includes("alice@acme.com"));
  assert.ok(!r.includes("AKIAIOSFODNN7EXAMPLE"));
  assert.ok(!r.includes("sk-ABCDEFGHIJKLMNOPQRSTUVWX"));
  assert.match(r, /\[REDACTED:email\]/);
  assert.match(r, /\[REDACTED:aws-access-key\]/);
  assert.match(r, /\[REDACTED:api-key\]/);
  assert.ok(r.includes("here is the plan"), "prose preserved");
});

test("redactText scrubs a private key block", () => {
  const s = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc123\n-----END OPENSSH PRIVATE KEY-----";
  assert.equal(redactText(s), "[REDACTED:private-key]");
});

test("redactText caps very long content", () => {
  const r = redactText("x".repeat(9000));
  assert.ok(r.length <= 4200);
  assert.ok(r.endsWith("[truncated]"));
});

test("redactText passes through empty/non-string", () => {
  assert.equal(redactText(""), "");
  assert.equal(redactText(null), null);
  assert.equal(redactText(undefined), undefined);
});
