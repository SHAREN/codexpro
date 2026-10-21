import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codexpro-binding-marker-"));
process.env.CODEXPRO_BINDING_CONFIRMATIONS_PATH = path.join(root, "binding-confirmed.json");

const {
  CODEXPRO_BINDING_MARKER_PREFIX,
  bindingMarkerForFingerprint,
  bindingMarkerFromCorrelation,
  responseBindingMarkerForRequest,
  responseBindingMarkerFromCorrelation,
  responseBindingConfirmedFromCorrelation,
  responseBindingInstruction
} = await import("../dist/bindingMarker.js");

const first = bindingMarkerForFingerprint("ABCDEF1234567890");
const same = bindingMarkerForFingerprint("abcdef123456");
const sameLong = bindingMarkerForFingerprint("abcdef1234567890");
const other = bindingMarkerForFingerprint("1111111111111111");

assert.ok(first?.startsWith(CODEXPRO_BINDING_MARKER_PREFIX));
assert.equal(first, same);
assert.equal(first, sameLong);
assert.notEqual(first, other);
assert.equal(first?.length, CODEXPRO_BINDING_MARKER_PREFIX.length + 24);
assert.equal(first?.includes("abcdef1234567890"), false);
assert.equal(bindingMarkerForFingerprint("not-a-fingerprint"), undefined);
assert.equal(
  bindingMarkerFromCorrelation({
    clientCorrelation: { "x-openai-session-fingerprint": "ABCDEF1234567890" }
  }),
  first
);
assert.equal(bindingMarkerFromCorrelation({ clientCorrelation: {} }), undefined);

const fingerprint = "2ed2cf363b38abcdef";
const requestA = "request-a";
const requestB = "request-b";
const markerA = responseBindingMarkerForRequest(fingerprint, requestA);
const markerB = responseBindingMarkerForRequest(fingerprint, requestB);

assert.match(markerA ?? "", /^cpb2_[0-9a-f]{24}$/);
assert.match(markerB ?? "", /^cpb2_[0-9a-f]{24}$/);
assert.notEqual(markerA, markerB, "cpb2 must be unique per request id");
assert.equal(responseBindingMarkerForRequest(fingerprint, requestA), markerA, "cpb2 must be deterministic for one request");
assert.equal(responseBindingMarkerFromCorrelation({
  requestId: requestA,
  clientCorrelation: { "x-openai-session-fingerprint": fingerprint }
}), markerA);
const instructionA = responseBindingInstruction(markerA);
assert.match(instructionA, new RegExp(markerA));
assert.match(instructionA, /very end of your final answer/i);

const serverSource = fs.readFileSync(new URL("../dist/server.js", import.meta.url), "utf8");
assert.match(serverSource, /codexpro_response_binding_instruction/);
assert.match(serverSource, /responseInstruction/);

const correlation = {
  requestId: requestA,
  clientCorrelation: { "x-openai-session-fingerprint": fingerprint }
};
assert.equal(responseBindingConfirmedFromCorrelation(correlation), false);

fs.writeFileSync(process.env.CODEXPRO_BINDING_CONFIRMATIONS_PATH, JSON.stringify({
  version: 1,
  bindings: {
    [fingerprint.slice(0, 12)]: {
      thread_id: "thread-legacy",
      provenance: "codexpro_supervisor_binding_marker",
      updated_at: "2026-10-13T08:00:00Z"
    }
  }
}));
assert.equal(responseBindingConfirmedFromCorrelation(correlation), false, "legacy binding must not suppress cpb2 revalidation");

await new Promise(resolve => setTimeout(resolve, 20));
fs.writeFileSync(process.env.CODEXPRO_BINDING_CONFIRMATIONS_PATH, JSON.stringify({
  version: 1,
  bindings: {
    [fingerprint.slice(0, 12)]: {
      thread_id: "thread-v2",
      provenance: "assistant_response_marker_v2",
      updated_at: "2026-10-13T08:01:00Z"
    }
  }
}));
assert.equal(responseBindingConfirmedFromCorrelation(correlation), true, "v2 confirmation must stop future marker instructions");

for (const [provenance, thread_id, expected] of [
  ["codexpro_tool_response_marker_v2", "thread-level1", true],
  ["cross_node_trace_match_v2", "thread-peer", true],
  ["cross_node_trace_match", "thread-legacy-peer", false],
  ["unknown", "thread-unknown", false],
  ["assistant_response_marker_v2", "", false],
  ["codexpro_tool_response_marker_v2", "unbound:abcdef123456", false]
]) {
  await new Promise(resolve => setTimeout(resolve, 20));
  fs.writeFileSync(process.env.CODEXPRO_BINDING_CONFIRMATIONS_PATH, JSON.stringify({
    version: 1,
    bindings: { [fingerprint.slice(0, 12)]: { thread_id, provenance } }
  }));
  assert.equal(responseBindingConfirmedFromCorrelation(correlation), expected, `${provenance}/${thread_id}`);
}
fs.unlinkSync(process.env.CODEXPRO_BINDING_CONFIRMATIONS_PATH);
assert.equal(responseBindingConfirmedFromCorrelation(correlation), false, "withdrawn confirmation must resume instructions");
fs.rmSync(root, { recursive: true, force: true });

console.log("✓ binding marker v1/v2 smoke test passed");
