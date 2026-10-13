import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Stable protocol identifier consumed by ChatGPT Control. If the derivation
// changes incompatibly, introduce a new prefix instead of redefining cpb1.
export const CODEXPRO_BINDING_MARKER_PREFIX = "cpb1_";
export const CODEXPRO_RESPONSE_BINDING_MARKER_PREFIX = "cpb2_";
const BINDING_MARKER_DOMAIN = "codexpro-binding-v1:";
const RESPONSE_BINDING_MARKER_DOMAIN = "codexpro-response-binding-v2:";
const CONFIRMED_BINDING_PROVENANCE = "assistant_response_marker_v2";

type ConfirmationCache = {
  path: string;
  mtimeMs: number;
  size: number;
  bindings: Record<string, { thread_id?: string; provenance?: string; updated_at?: string }>;
};

let confirmationCache: ConfirmationCache | undefined;

export function normalizeBindingFingerprint(value: unknown): string | undefined {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{12,128}$/.test(normalized)) return undefined;
  return normalized.slice(0, 12);
}

function correlationFingerprint(snapshot: Record<string, unknown> | undefined): string | undefined {
  const clientCorrelation = snapshot?.clientCorrelation;
  if (!clientCorrelation || typeof clientCorrelation !== "object" || Array.isArray(clientCorrelation)) return undefined;
  return normalizeBindingFingerprint((clientCorrelation as Record<string, unknown>)["x-openai-session-fingerprint"]);
}

export function bindingMarkerForFingerprint(value: unknown): string | undefined {
  const fingerprint = normalizeBindingFingerprint(value);
  if (!fingerprint) return undefined;
  const digest = createHash("sha256")
    .update(BINDING_MARKER_DOMAIN, "utf8")
    .update(fingerprint, "utf8")
    .digest("hex")
    .slice(0, 24);
  return CODEXPRO_BINDING_MARKER_PREFIX + digest;
}

export function bindingMarkerFromCorrelation(snapshot: Record<string, unknown> | undefined): string | undefined {
  return bindingMarkerForFingerprint(correlationFingerprint(snapshot));
}

export function responseBindingMarkerForRequest(fingerprintValue: unknown, requestIdValue: unknown): string | undefined {
  const fingerprint = normalizeBindingFingerprint(fingerprintValue);
  const requestId = String(requestIdValue ?? "").trim();
  if (!fingerprint || !requestId || requestId.length > 256) return undefined;
  const digest = createHash("sha256")
    .update(RESPONSE_BINDING_MARKER_DOMAIN, "utf8")
    .update(fingerprint, "utf8")
    .update("\n", "utf8")
    .update(requestId, "utf8")
    .digest("hex")
    .slice(0, 24);
  return CODEXPRO_RESPONSE_BINDING_MARKER_PREFIX + digest;
}

export function responseBindingMarkerFromCorrelation(snapshot: Record<string, unknown> | undefined): string | undefined {
  return responseBindingMarkerForRequest(correlationFingerprint(snapshot), snapshot?.requestId);
}

function confirmationPath(): string {
  const configured = String(process.env.CODEXPRO_BINDING_CONFIRMATIONS_PATH ?? "").trim();
  if (configured) return path.resolve(configured);
  return path.join(os.homedir(), ".codexpro", "thread-monitor", "binding-confirmed.json");
}

function confirmedBindings(): Record<string, { thread_id?: string; provenance?: string; updated_at?: string }> {
  const file = confirmationPath();
  try {
    const stat = statSync(file);
    if (confirmationCache && confirmationCache.path === file && confirmationCache.mtimeMs === stat.mtimeMs && confirmationCache.size === stat.size) {
      return confirmationCache.bindings;
    }
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const raw = parsed?.bindings;
    const bindings = raw && typeof raw === "object" && !Array.isArray(raw)
      ? raw as Record<string, { thread_id?: string; provenance?: string; updated_at?: string }>
      : {};
    confirmationCache = { path: file, mtimeMs: stat.mtimeMs, size: stat.size, bindings };
    return bindings;
  } catch {
    confirmationCache = undefined;
    return {};
  }
}

export function responseBindingConfirmedFromCorrelation(snapshot: Record<string, unknown> | undefined): boolean {
  const fingerprint = correlationFingerprint(snapshot);
  if (!fingerprint) return false;
  const entry = confirmedBindings()[fingerprint];
  return Boolean(entry?.thread_id && entry?.provenance === CONFIRMED_BINDING_PROVENANCE);
}

export function responseBindingInstruction(marker: string): string {
  return [
    "[CodexPro thread binding]",
    "This ChatGPT conversation is not yet confirmed for this CodexPro session.",
    `At the very end of your final answer to the user, append this exact token on its own line: ${marker}`,
    "If a later CodexPro tool result in this same assistant turn gives another cpb2_ token, output only the latest token.",
    "Do not explain, quote, transform, or omit the token."
  ].join("\n");
}
