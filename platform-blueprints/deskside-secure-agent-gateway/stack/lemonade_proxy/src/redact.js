// Copyright © Advanced Micro Devices, Inc., or its affiliates.
//
// SPDX-License-Identifier: MIT

// Text redactor for LLM prompt/completion content (Cisco telemetry delta #5).
//
// Content capture is on by default and redacted (see server.js LLM_CAPTURE_CONTENT /
// GLASSBOX_ALLOW_RAW_LLM_CONTENT). This scrubs common secrets before the text is
// shipped and caps length so a span never carries an unbounded body. It is a
// best-effort filter, not a guarantee; DefenseClaw remains the content authority.

const MAX_CHARS = Number(process.env.LLM_CONTENT_MAX_CHARS || 4000);

const RULES = [
  [/-----BEGIN[\s\S]*?PRIVATE KEY-----[\s\S]*?-----END[\s\S]*?PRIVATE KEY-----/g, "[REDACTED:private-key]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED:aws-access-key]"],
  [/\bsk-[A-Za-z0-9]{16,}\b/g, "[REDACTED:api-key]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED:github-token]"],
  [/\bBearer\s+[A-Za-z0-9._\-]{16,}\b/gi, "[REDACTED:bearer]"],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[REDACTED:email]"],
];

/** Scrub common secrets and cap length. Returns the input unchanged for empty or
 *  non-string values. */
export function redactText(value) {
  if (typeof value !== "string" || value === "") return value;
  let out = value;
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  if (out.length > MAX_CHARS) out = out.slice(0, MAX_CHARS) + "…[truncated]";
  return out;
}
