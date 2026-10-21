// Some MCP consumers retain only the primary text block. Keep binding metadata
// beside the actual result as well as in structuredContent and the footer block.
export function withPrimaryBindingContent(content: any[], tool: string, marker: string, instruction: string): any[] {
  const index = content.findIndex(item => item?.type === "text" && typeof item.text === "string");
  if (index < 0) return content;
  const item = content[index];
  let text: string;
  try {
    const value = JSON.parse(item.text);
    // Preserve JSON arrays/scalars exactly; they have no metadata namespace.
    if (!value || typeof value !== "object" || Array.isArray(value)) return content;
    text = JSON.stringify({ ...value, codexpro_tool: tool,
      codexpro_response_binding_marker: marker,
      codexpro_response_binding_instruction: instruction });
  } catch {
    text = `${item.text}\n\n${instruction}`;
  }
  return content.map((entry, i) => i === index ? { ...entry, text } : entry);
}
