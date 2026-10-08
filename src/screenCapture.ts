import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CodexProError } from "./guard.js";

const execFileAsync = promisify(execFile);
const helperPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "codexpro-screen.ps1");

export type ScreenCaptureMode = "full" | "primary" | "monitor" | "foreground" | "window";

export interface WindowSummary {
  handle: number;
  pid: number;
  processName: string;
  title: string;
  minimized: boolean;
  bounds: { left: number; top: number; width: number; height: number };
}

export interface ScreenCaptureOptions {
  mode: ScreenCaptureMode;
  monitorIndex?: number;
  pid?: number;
  processName?: string;
  title?: string;
  maxWidth?: number;
  maxHeight?: number;
}

export interface ScreenCaptureResult {
  png: Buffer;
  metadata: {
    mode: ScreenCaptureMode;
    method: string;
    width: number;
    height: number;
    originalWidth: number;
    originalHeight: number;
    bounds: { left: number; top: number; width: number; height: number };
    monitorIndex?: number;
    window?: WindowSummary;
  };
}

function requireWindows(): void {
  if (process.platform !== "win32") throw new CodexProError("Screen capture tools are available only on Windows hosts.");
}

function powershellExecutable(): string {
  return path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function boundedInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value as number)));
}

async function runHelper(args: string[], timeout = 20_000): Promise<string> {
  requireWindows();
  try {
    const result = await execFileAsync(
      powershellExecutable(),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helperPath, ...args],
      { windowsHide: true, timeout, maxBuffer: 2_000_000, encoding: "utf8" }
    );
    return result.stdout.trim();
  } catch (error: any) {
    const detail = String(error?.stderr || error?.message || error).trim();
    throw new CodexProError(`Windows screen helper failed: ${detail || "unknown error"}`);
  }
}

function parseJson<T>(value: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new CodexProError("Windows screen helper returned invalid JSON.");
  }
}

export async function listVisibleWindows(options: {
  title?: string;
  processName?: string;
  includeMinimized?: boolean;
  limit?: number;
} = {}): Promise<WindowSummary[]> {
  const args = ["-Action", "list", "-Limit", String(boundedInt(options.limit, 80, 1, 200))];
  if (options.title) args.push("-Title", options.title);
  if (options.processName) args.push("-ProcessName", options.processName);
  if (options.includeMinimized) args.push("-IncludeMinimized");
  return parseJson<WindowSummary[]>(await runHelper(args));
}

export async function captureScreen(options: ScreenCaptureOptions): Promise<ScreenCaptureResult> {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codexpro-screen-"));
  const outputPath = path.join(tempDir, "capture.png");
  const args = [
    "-Action", "capture", "-Mode", options.mode, "-OutputPath", outputPath,
    "-MaxWidth", String(boundedInt(options.maxWidth, 1920, 320, 4096)),
    "-MaxHeight", String(boundedInt(options.maxHeight, 1200, 240, 4096))
  ];
  if (options.monitorIndex !== undefined) args.push("-MonitorIndex", String(boundedInt(options.monitorIndex, 0, 0, 31)));
  if (options.pid !== undefined) args.push("-Pid", String(boundedInt(options.pid, 0, 1, 2_147_483_647)));
  if (options.processName) args.push("-ProcessName", options.processName);
  if (options.title) args.push("-Title", options.title);

  try {
    const metadata = parseJson<ScreenCaptureResult["metadata"]>(await runHelper(args, 30_000));
    const png = await fsp.readFile(outputPath);
    if (png.length < 8 || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
      throw new CodexProError("Windows screen helper did not create a valid PNG image.");
    }
    return { png, metadata };
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
}
