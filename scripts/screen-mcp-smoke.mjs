import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

if (process.platform !== "win32") {
  console.log("screen MCP smoke skipped: Windows only");
  process.exit(0);
}

const port = 8878;
const token = "codexpro-screen-mcp-smoke-token";
const child = spawn(process.execPath, [path.resolve("dist/http.js")], {
  cwd: path.resolve("."),
  env: {
    ...process.env,
    CODEXPRO_ROOT: path.resolve("."),
    CODEXPRO_ALLOWED_ROOTS: path.resolve("."),
    CODEXPRO_HOST: "127.0.0.1",
    CODEXPRO_PORT: String(port),
    CODEXPRO_HTTP_TOKEN: token,
    CODEXPRO_BASH_MODE: "off",
    CODEXPRO_WRITE_MODE: "off",
    CODEXPRO_TOOL_MODE: "full",
    CODEXPRO_TOOL_CARDS: "0",
    CODEXPRO_SCREEN_CAPTURE: "1"
  },
  stdio: ["ignore", "ignore", "pipe"],
  windowsHide: true
});

let stderr = "";
child.stderr.on("data", (chunk) => { stderr += String(chunk); });

async function waitForHealth() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.status === 401) return;
    } catch { }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`screen MCP server failed to start: ${stderr}`);
}

try {
  await waitForHealth();
  const client = new Client({ name: "codexpro-screen-smoke", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp?codexpro_token=${token}`)));
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name);
  if (!names.includes("list_windows") || !names.includes("capture_screen")) throw new Error("screen tools are not registered");
  const listed = await client.callTool({ name: "list_windows", arguments: { limit: 5 } });
  if (listed.isError || Number(listed.structuredContent?.count ?? -1) < 0) throw new Error("list_windows failed");
  const captured = await client.callTool({ name: "capture_screen", arguments: { mode: "primary", max_width: 640, max_height: 480 } });
  const image = captured.content?.find((item) => item.type === "image");
  if (captured.isError || !image || image.mimeType !== "image/png" || !image.data) throw new Error("capture_screen did not return PNG image content");
  console.log(JSON.stringify({ ok: true, tools: names.length, windows: listed.structuredContent?.count, pngBase64Chars: image.data.length }));
  await client.close();
} finally {
  child.kill();
  await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3000))]);
}
