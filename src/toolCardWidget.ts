export const TOOL_CARD_URI = "ui://widget/codexpro-tool-card-v10.html";
export const TOOL_CARD_MIME_TYPE = "text/html;profile=mcp-app";

export const toolCardWidgetHtml = String.raw`
<div id="root" class="wrap">
  <details class="mini">
    <summary>CodexPro: waiting for tool result...</summary>
    <pre>Waiting for tool result...</pre>
  </details>
</div>

<style>
  :root {
    color-scheme: dark light;
    --text: #eef2f7;
    --muted: #a5adba;
    --line: rgba(148, 163, 184, 0.22);
    --ok: #8edc99;
    --warn: #e8c978;
    --bad: #f29a9a;
  }

  * { box-sizing: border-box; }

  body {
    margin: 0;
    background: transparent;
    color: var(--text);
    font: 12px/1.35 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  }

  .wrap {
    width: 100%;
    max-width: 100%;
  }

  .mini {
    width: 100%;
    margin: 0;
    padding: 0;
    border: 0;
    background: transparent;
  }

  .mini > summary {
    overflow: hidden;
    width: 100%;
    min-height: 18px;
    padding: 0;
    color: var(--muted);
    cursor: pointer;
    list-style-position: inside;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mini > summary::-webkit-details-marker {
    opacity: 0.55;
  }

  .mini > summary:focus {
    outline: none;
  }

  .mini > summary:focus-visible {
    outline: 1px solid var(--line);
    outline-offset: 2px;
  }

  .mini pre {
    overflow: auto;
    max-height: 160px;
    margin: 4px 0 0;
    padding: 4px 0 0;
    border-top: 1px solid var(--line);
    color: var(--muted);
    font: inherit;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .state-ok summary { color: var(--ok); }
  .state-warn summary { color: var(--warn); }
  .state-bad summary { color: var(--bad); }
</style>

<script>
  const root = document.getElementById("root");

  function esc(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function short(value, max) {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    if (!text) return "";
    return text.length > max ? text.slice(0, Math.max(0, max - 1)) + "…" : text;
  }

  function lines(value, maxLines, maxChars) {
    const text = String(value ?? "").replace(/\r\n/g, "\n");
    if (!text.trim()) return "";
    const selected = text.split("\n").slice(0, maxLines).join("\n");
    return selected.length > maxChars ? selected.slice(0, maxChars - 1) + "…" : selected;
  }

  function base(value) {
    const text = String(value ?? "");
    return text.split(/[\\/]/).filter(Boolean).pop() || text || "workspace";
  }

  function titleFor(tool) {
    const titles = {
      server_config: "Config",
      codexpro_self_test: "Self-test",
      codexpro_inventory: "Inventory",
      list_workspaces: "Workspaces",
      open_current_workspace: "Workspace",
      open_workspace: "Workspace",
      workspace_snapshot: "Snapshot",
      tree: "Tree",
      search: "Search",
      read: "Read",
      write: "Write",
      edit: "Edit",
      bash: "Bash",
      git_status: "Git status",
      git_diff: "Git diff",
      show_changes: "Changes",
      read_handoff: "Handoff",
      export_pro_context: "Pro context",
      codex_context: "Context",
      handoff_to_agent: "Agent handoff",
      handoff_to_codex: "Codex handoff"
    };
    return titles[tool] || "CodexPro";
  }

  function stateFor(data) {
    if (data?.is_error || data?.error || data?.exitCode > 0 || data?.failed > 0 || data?.status === "fail") return "bad";
    if (data?.warned > 0 || data?.status === "warn" || data?.truncated) return "warn";
    return "ok";
  }

  function summaryFor(data) {
    if (!data || typeof data !== "object" || !Object.keys(data).length || data.codexpro_tool === "codexpro") {
      return "CodexPro: waiting for tool result...";
    }

    const tool = data.codexpro_tool || "codexpro";
    const title = data.codexpro_title || titleFor(tool);

    if (data.is_error || data.error) return title + ": ERROR " + short(data.error || data.message, 140);

    if (tool === "server_config") {
      const roots = Array.isArray(data.allowedRoots) ? data.allowedRoots.length : 0;
      return title + ": bash " + (data.bashMode || "?") + ", tools " + (data.toolMode || "?") + ", write " + (data.writeMode || "?") + ", roots " + roots;
    }

    if (tool === "codexpro_self_test") {
      return title + ": " + (data.status || "ok") + ", " + (data.passed ?? 0) + " passed, " + (data.warned ?? 0) + " warned, " + (data.failed ?? 0) + " failed";
    }

    if (tool === "open_current_workspace" || tool === "open_workspace" || tool === "workspace_snapshot") {
      return title + ": " + short(data.root || data.path || "workspace", 170);
    }

    if (tool === "tree") {
      return title + ": " + short(data.path || data.root || "workspace", 120) + " · " + (data.entries ?? "?") + " entries";
    }

    if (tool === "search") {
      const count = Array.isArray(data.matches) ? data.matches.length : data.count ?? 0;
      return title + ": " + count + " matches" + (data.truncated ? " · truncated" : "");
    }

    if (tool === "read") {
      const range = data.startLine && data.endLine ? ":L" + data.startLine + "-" + data.endLine : "";
      return title + ": " + short(data.path || "file", 140) + range;
    }

    if (tool === "write" || tool === "edit") {
      return title + ": " + short(data.path || "file", 120) + " +" + (data.additions ?? 0) + " -" + (data.deletions ?? 0);
    }

    if (tool === "bash") {
      return title + ": exit " + (data.exitCode ?? "?") + " · " + short(data.command || "command", 150);
    }

    if (tool === "git_status") {
      const changed = Array.isArray(data.changed_files) ? data.changed_files.length : 0;
      return title + ": " + (changed ? changed + " changed" : "clean");
    }

    if (tool === "show_changes") {
      const files = Array.isArray(data.files) ? data.files.length : Array.isArray(data.changed_files) ? data.changed_files.length : 0;
      return title + ": " + (files ? files + " files" : "clean");
    }

    if (tool === "git_diff") {
      return title + ": " + (data.bytes ?? String(data.diff || "").length) + " bytes";
    }

    const path = data.path || data.root || data.workspace_id || "ready";
    return title + ": " + short(path, 180);
  }

  function detailFor(data) {
    if (!data || typeof data !== "object") return "";
    const out = [];
    const push = (label, value) => {
      if (value === undefined || value === null || value === "") return;
      out.push(label + ": " + String(value));
    };

    push("tool", data.codexpro_tool || data.codexpro_title);
    push("root", data.root);
    push("path", data.path);
    push("cwd", data.cwd);
    push("command", data.command);
    push("exit", data.exitCode);
    push("status", data.status);
    push("workspace", data.workspace_id);
    push("entries", data.entries);
    push("matches", Array.isArray(data.matches) ? data.matches.length : data.count);
    push("changed", Array.isArray(data.changed_files) ? data.changed_files.length : undefined);
    push("additions", data.additions);
    push("deletions", data.deletions);
    push("truncated", data.truncated ? "true" : undefined);
    push("error", data.error || data.status_error);

    const preview = data.stdout || data.stderr || data.text || data.diff || data.git_status || data.status_text || data.git_diff;
    const previewText = lines(preview, 12, 1800);
    if (previewText) out.push("preview:\n" + previewText);

    if (!out.length) out.push(lines(JSON.stringify(data, null, 2), 20, 2200));
    return out.join("\n");
  }

  function render(data) {
    const state = stateFor(data);
    root.innerHTML = '<details class="mini state-' + esc(state) + '"><summary>' + esc(summaryFor(data)) + '</summary><pre>' + esc(detailFor(data)) + '</pre></details>';
  }

  render(window.openai?.toolOutput || window.openai?.toolResponseMetadata || {});

  window.addEventListener("openai:set_globals", (event) => {
    render(event.detail?.globals?.toolOutput || window.openai?.toolOutput || {});
  }, { passive: true });

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (!message || message.jsonrpc !== "2.0") return;
    if (message.method === "ui/notifications/tool-result") {
      render(message.params?.structuredContent || {});
    }
  }, { passive: true });
</script>
`.trim();
