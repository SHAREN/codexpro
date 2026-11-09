import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readTextFile } from "../dist/fsOps.js";
import { searchWorkspace } from "../dist/searchOps.js";
import { PathGuard } from "../dist/guard.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-bounded-io-"));
const config = {
  maxReadBytes: 4_000,
  maxOutputBytes: 4_000,
  maxSearchResults: 10,
  blockedGlobs: [],
  analysisEnabled: false
};
const workspace = { id: "ws_bounded_io_smoke", root, openedAt: new Date().toISOString() };
const guard = new PathGuard(config);

try {
  const lines = Array.from({ length: 180 }, (_, i) => `row-${i} ${"x".repeat(50)}`);
  await fs.writeFile(path.join(root, "oversize.txt"), lines.join("\n") + "\n");
  const first = await readTextFile(config, guard, workspace, "oversize.txt");
  assert.equal(first.truncated, true);
  assert.equal(first.startLine, 1);
  assert.ok(first.endLine > 1 && first.endLine < first.totalLines);
  assert.ok(Buffer.byteLength(first.text, "utf8") <= config.maxReadBytes);
  const next = await readTextFile(config, guard, workspace, "oversize.txt", {
    startLine: first.endLine + 1,
    endLine: first.totalLines
  });
  assert.equal(next.startLine, first.endLine + 1);
  assert.ok(next.endLine >= next.startLine);
  assert.ok(Buffer.byteLength(next.text, "utf8") <= config.maxReadBytes);
  assert.equal(next.sha256, first.sha256);

  const limited = await readTextFile(config, guard, workspace, "oversize.txt", {
    startLine: 1,
    endLine: 180,
    maxBytes: 1_000
  });
  assert.equal(limited.truncated, true);
  assert.ok(limited.endLine < 180);
  assert.ok(Buffer.byteLength(limited.text, "utf8") <= 1_000);

  await fs.writeFile(path.join(root, "single-line.txt"), "z".repeat(5_000));
  await assert.rejects(
    () => readTextFile(config, guard, workspace, "single-line.txt"),
    /Single line .* exceeds read limit/
  );

  if (process.platform !== "win32") {
    const bin = path.join(root, "bin");
    await fs.mkdir(bin);
    const fakeRg = `#!/usr/bin/env node
const path = require("node:path");
if (process.argv.includes("--version")) {
  console.log("ripgrep smoke");
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  type: "match",
  data: {
    path: { text: path.join(process.cwd(), "oversize.txt") },
    line_number: 1,
    lines: { text: "marker\\n" }
  }
}) + "\\n");
setInterval(() => {}, 1_000);
`;
    const rgPath = path.join(bin, "rg");
    await fs.writeFile(rgPath, fakeRg, { mode: 0o755 });
    const oldPath = process.env.PATH;
    const oldTimeout = process.env.CODEXPRO_RG_TIMEOUT_MS;
    try {
      process.env.PATH = `${bin}:${oldPath ?? ""}`;
      process.env.CODEXPRO_RG_TIMEOUT_MS = "400";
      const started = Date.now();
      const searched = await searchWorkspace(config, guard, workspace, {
        query: "marker",
        root: ".",
        regex: false,
        includeHidden: false,
        maxResults: 5
      });
      assert.ok(Date.now() - started < 5_000, "ripgrep timeout did not bound execution");
      assert.equal(searched.used, "ripgrep");
      assert.equal(searched.truncated, true);
      assert.ok(searched.text.includes("Search timed out"));
      assert.equal(searched.matches.length, 1);
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      if (oldTimeout === undefined) delete process.env.CODEXPRO_RG_TIMEOUT_MS;
      else process.env.CODEXPRO_RG_TIMEOUT_MS = oldTimeout;
    }
  }

  console.log("PASS: bounded reads and ripgrep timeout");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
