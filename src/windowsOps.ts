import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { CodexProError } from "./guard.js";

const execFileAsync = promisify(execFile);

export const WINDOWS_CONTROL_ACTIONS = [
  "status",
  "disk_space",
  "wsl_status",
  "wsl_list",
  "wsl_shutdown",
  "wsl_terminate",
  "service_status",
  "service_restart",
  "event_log"
] as const;

export const WINDOWS_SERVICE_NAMES = ["WslService", "LxssManager", "vmcompute"] as const;
export const WINDOWS_EVENT_LOGS = ["wsl", "hyperv_compute", "system"] as const;

export type WindowsControlAction = (typeof WINDOWS_CONTROL_ACTIONS)[number];
export type WindowsServiceName = (typeof WINDOWS_SERVICE_NAMES)[number];
export type WindowsEventLogKind = (typeof WINDOWS_EVENT_LOGS)[number];

export interface WindowsControlOptions {
  action: WindowsControlAction;
  service?: WindowsServiceName;
  distro?: string;
  eventLog?: WindowsEventLogKind;
  limit?: number;
  timeoutMs?: number;
}

export interface WindowsNativeCommandResult {
  executable: string;
  args: string[];
  ok: boolean;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface WindowsDiskSpace {
  root: string;
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  freePercent: number;
}

export interface WindowsControlResult {
  action: WindowsControlAction;
  ok: boolean;
  changed: boolean;
  durationMs: number;
  platform: NodeJS.Platform;
  hostname: string;
  data?: unknown;
  commands: WindowsNativeCommandResult[];
}

const OUTPUT_LIMIT_BYTES = 40_000;
const DEFAULT_TIMEOUT_MS = 8_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 30_000;

function requireWindows(): void {
  if (process.platform !== "win32") {
    throw new CodexProError("windows_control is available only when CodexPro is running natively on Windows.");
  }
}

function system32Executable(name: string): string {
  return path.join(process.env.SystemRoot || "C:\\Windows", "System32", name);
}

function powershellExecutable(): string {
  return path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function boundedTimeout(value: number | undefined): number {
  const candidate = Number.isFinite(value) ? Math.trunc(value as number) : DEFAULT_TIMEOUT_MS;
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, candidate));
}

function boundedLimit(value: number | undefined): number {
  const candidate = Number.isFinite(value) ? Math.trunc(value as number) : 30;
  return Math.max(1, Math.min(100, candidate));
}

function trimOutput(value: unknown): string {
  const text = String(value ?? "");
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= OUTPUT_LIMIT_BYTES) return text.trim();
  return `${buffer.subarray(0, OUTPUT_LIMIT_BYTES).toString("utf8").trim()}\n...[output truncated to ${OUTPUT_LIMIT_BYTES} bytes]`;
}

async function runNative(executable: string, args: string[], timeoutMs: number): Promise<WindowsNativeCommandResult> {
  const start = Date.now();
  try {
    const result = await execFileAsync(executable, args, {
      windowsHide: true,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 512_000,
      encoding: "utf8"
    });
    return {
      executable,
      args,
      ok: true,
      exitCode: 0,
      signal: null,
      durationMs: Date.now() - start,
      stdout: trimOutput(result.stdout),
      stderr: trimOutput(result.stderr),
      timedOut: false
    };
  } catch (error: any) {
    const message = String(error?.message ?? error ?? "");
    const timedOut = Boolean(error?.killed) || /timed out|timeout/i.test(message);
    return {
      executable,
      args,
      ok: false,
      exitCode: typeof error?.code === "number" ? error.code : null,
      signal: typeof error?.signal === "string" ? error.signal : null,
      durationMs: Date.now() - start,
      stdout: trimOutput(error?.stdout),
      stderr: trimOutput(error?.stderr || message),
      timedOut
    };
  }
}

function diskSpaceSnapshot(): WindowsDiskSpace[] {
  const roots = ["C:\\", "D:\\"].filter((root) => fs.existsSync(root));
  const disks: WindowsDiskSpace[] = [];
  for (const root of roots) {
    try {
      const stat = fs.statfsSync(root);
      const blockSize = Number(stat.bsize);
      const totalBytes = blockSize * Number(stat.blocks);
      const freeBytes = blockSize * Number(stat.bavail);
      const usedBytes = Math.max(0, totalBytes - freeBytes);
      disks.push({
        root,
        totalBytes,
        freeBytes,
        usedBytes,
        freePercent: totalBytes > 0 ? Number(((freeBytes / totalBytes) * 100).toFixed(2)) : 0
      });
    } catch {
      // One inaccessible drive should not make the whole emergency status unavailable.
    }
  }
  return disks;
}

function normalizeDistro(value: string | undefined): string {
  const distro = value?.trim();
  if (!distro) throw new CodexProError("distro is required for action=wsl_terminate.");
  if (distro.length > 128 || /[\r\n\0]/.test(distro)) {
    throw new CodexProError("distro must be a single Windows WSL distribution name up to 128 characters.");
  }
  return distro;
}

function normalizeService(value: WindowsServiceName | undefined): WindowsServiceName {
  if (!value || !WINDOWS_SERVICE_NAMES.includes(value)) {
    throw new CodexProError(`service must be one of: ${WINDOWS_SERVICE_NAMES.join(", ")}.`);
  }
  return value;
}

function serviceState(output: string): "running" | "stopped" | "pending" | "unknown" {
  const normalized = output.toUpperCase();
  // sc.exe localizes field labels, but the numeric state and state token remain stable.
  if (/:\s*4\s+RUNNING\b/.test(normalized)) return "running";
  if (/:\s*1\s+STOPPED\b/.test(normalized)) return "stopped";
  if (/:\s*(?:2|3|5|6|7)\s+/.test(normalized)) return "pending";
  return "unknown";
}

async function waitForServiceState(
  service: WindowsServiceName,
  expected: "running" | "stopped",
  timeoutMs: number,
  commands: WindowsNativeCommandResult[]
): Promise<boolean> {
  const sc = system32Executable("sc.exe");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const query = await runNative(sc, ["query", service], Math.min(3_000, timeoutMs));
    commands.push(query);
    if (query.ok && serviceState(query.stdout) === expected) return true;
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  return false;
}

async function restartService(service: WindowsServiceName, timeoutMs: number): Promise<{ ok: boolean; commands: WindowsNativeCommandResult[] }> {
  const commands: WindowsNativeCommandResult[] = [];
  const sc = system32Executable("sc.exe");
  const initial = await runNative(sc, ["query", service], Math.min(4_000, timeoutMs));
  commands.push(initial);
  if (!initial.ok) return { ok: false, commands };

  if (serviceState(initial.stdout) !== "stopped") {
    const stop = await runNative(sc, ["stop", service], Math.min(5_000, timeoutMs));
    commands.push(stop);
    if (!stop.ok && serviceState(stop.stdout) !== "stopped") return { ok: false, commands };
    if (!(await waitForServiceState(service, "stopped", Math.min(8_000, timeoutMs), commands))) {
      return { ok: false, commands };
    }
  }

  const start = await runNative(sc, ["start", service], Math.min(5_000, timeoutMs));
  commands.push(start);
  if (!start.ok) return { ok: false, commands };
  const running = await waitForServiceState(service, "running", Math.min(8_000, timeoutMs), commands);
  return { ok: running, commands };
}

function eventLogScript(kind: WindowsEventLogKind, limit: number): string {
  if (kind === "hyperv_compute") {
    return `$ErrorActionPreference='Stop'; Get-WinEvent -LogName 'Microsoft-Windows-Hyper-V-Compute-Admin' -MaxEvents ${limit} | Select-Object TimeCreated,Id,LevelDisplayName,ProviderName,Message | ConvertTo-Json -Compress -Depth 3`;
  }
  if (kind === "system") {
    return `$ErrorActionPreference='Stop'; Get-WinEvent -LogName 'System' -MaxEvents 600 | Where-Object { $_.ProviderName -match 'Hyper-V|Host Compute|Lxss|WSL|vmcompute' -or $_.Message -match 'HCS_E_|WSL|vmcompute|Host Compute' } | Select-Object -First ${limit} TimeCreated,Id,LevelDisplayName,ProviderName,Message | ConvertTo-Json -Compress -Depth 3`;
  }
  return `$ErrorActionPreference='Stop'; $events = Get-WinEvent -LogName 'System' -MaxEvents 800 | Where-Object { $_.ProviderName -match 'Lxss|WSL|Subsystem.*Linux|Hyper-V-Compute' -or $_.Message -match 'HCS_E_|WSL|Windows Subsystem for Linux' } | Select-Object -First ${limit} TimeCreated,Id,LevelDisplayName,ProviderName,Message; $events | ConvertTo-Json -Compress -Depth 3`;
}

export async function runWindowsControl(options: WindowsControlOptions): Promise<WindowsControlResult> {
  requireWindows();
  const started = Date.now();
  const timeoutMs = boundedTimeout(options.timeoutMs);
  const commands: WindowsNativeCommandResult[] = [];
  let data: unknown;
  let changed = false;
  let ok = true;

  const wsl = system32Executable("wsl.exe");
  const sc = system32Executable("sc.exe");

  switch (options.action) {
    case "disk_space": {
      data = { disks: diskSpaceSnapshot() };
      break;
    }
    case "wsl_status": {
      const result = await runNative(wsl, ["--status"], timeoutMs);
      commands.push(result);
      ok = result.ok;
      break;
    }
    case "wsl_list": {
      const result = await runNative(wsl, ["--list", "--verbose"], timeoutMs);
      commands.push(result);
      ok = result.ok;
      break;
    }
    case "wsl_shutdown": {
      changed = true;
      const result = await runNative(wsl, ["--shutdown"], timeoutMs);
      commands.push(result);
      ok = result.ok;
      break;
    }
    case "wsl_terminate": {
      changed = true;
      const distro = normalizeDistro(options.distro);
      const result = await runNative(wsl, ["--terminate", distro], timeoutMs);
      commands.push(result);
      ok = result.ok;
      data = { distro };
      break;
    }
    case "service_status": {
      const service = normalizeService(options.service);
      const result = await runNative(sc, ["query", service], timeoutMs);
      commands.push(result);
      ok = result.ok;
      data = { service, state: serviceState(result.stdout) };
      break;
    }
    case "service_restart": {
      changed = true;
      const service = normalizeService(options.service);
      const restarted = await restartService(service, timeoutMs);
      commands.push(...restarted.commands);
      ok = restarted.ok;
      data = { service };
      break;
    }
    case "event_log": {
      const eventLog = options.eventLog ?? "wsl";
      const limit = boundedLimit(options.limit);
      const result = await runNative(
        powershellExecutable(),
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", eventLogScript(eventLog, limit)],
        timeoutMs
      );
      commands.push(result);
      ok = result.ok;
      data = { eventLog, limit };
      break;
    }
    case "status": {
      const disks = diskSpaceSnapshot();
      const serviceResults = await Promise.all(
        WINDOWS_SERVICE_NAMES.map((service) => runNative(sc, ["query", service], Math.min(4_000, timeoutMs)))
      );
      commands.push(...serviceResults);
      const wslStatus = await runNative(wsl, ["--status"], Math.min(5_000, timeoutMs));
      commands.push(wslStatus);
      data = {
        uptimeSeconds: Math.trunc(os.uptime()),
        disks,
        services: WINDOWS_SERVICE_NAMES.map((service, index) => ({
          service,
          ok: serviceResults[index]?.ok ?? false,
          state: serviceState(serviceResults[index]?.stdout ?? "")
        })),
        wslResponsive: wslStatus.ok,
        wslTimedOut: wslStatus.timedOut
      };
      ok = serviceResults.some((result) => result.ok) || disks.length > 0;
      break;
    }
    default:
      throw new CodexProError(`Unsupported Windows control action: ${String(options.action)}.`);
  }

  return {
    action: options.action,
    ok,
    changed,
    durationMs: Date.now() - started,
    platform: process.platform,
    hostname: os.hostname(),
    data,
    commands
  };
}
