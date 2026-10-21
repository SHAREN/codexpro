// Observe the returned MCP result without retaining result text or tool arguments.
// This proves server-side tagging, not receipt by ChatGPT or model compliance.
export function recordBindingEmission(
  result: any, tool: string, correlation: Record<string, unknown> | undefined,
  confirmed: boolean, marker: string | undefined, instruction: string | undefined
): void {
  if (process.env.CODEXPRO_LOG_TOOL_CALLS !== "1" && process.env.CODEXPRO_LOG_REQUESTS !== "1") return;
  try {
    const raw = (correlation?.clientCorrelation as Record<string, unknown> | undefined)?.["x-openai-session-fingerprint"];
    const fingerprint = typeof raw === "string" && /^[a-f0-9]{12,128}$/i.test(raw) ? raw.slice(0, 12).toLowerCase() : undefined;
    if (!fingerprint) return;
    const expected = typeof marker === "string" && /^cpb2_[a-f0-9]{24}$/.test(marker) ? marker : undefined;
    const content = Array.isArray(result?.content) ? result.content : [];
    const event = {
      ts: new Date().toISOString(), event: "binding_emission", tool: tool.slice(0, 80),
      clientSessionFingerprint: fingerprint,
      requestId: typeof correlation?.requestId === "string" ? correlation.requestId.slice(0, 256) : undefined,
      confirmed, expectedMarker: expected,
      markerInStructuredContent: Boolean(expected && result?.structuredContent?.codexpro_response_binding_marker === expected),
      instructionInContent: Boolean(expected && instruction && content.some((item: any) => item?.type === "text" && item.text === instruction)),
      markerInContent: Boolean(expected && content.some((item: any) => item?.type === "text" && typeof item.text === "string" && item.text.includes(expected))),
      markerInPrimaryText: Boolean(expected && content.find((item: any) => item?.type === "text")?.text?.includes(expected)),
      isError: result?.isError === true
    };
    console.error(`[CodexProBindingEmission] ${JSON.stringify(event)}`);
  } catch {
    // Diagnostics must not change a tool's return or turn success into failure.
  }
}
