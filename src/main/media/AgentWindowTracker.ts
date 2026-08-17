import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { screen } from "electron";
import type { AgentConfig } from "../../agents/types";

const execFileAsync = promisify(execFile);
const REFRESH_INTERVAL_MS = 1_500;
const NATIVE_SCAN_TIMEOUT_MS = 10_000;

export interface AgentWindowRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface AgentWindowDisplayRegion {
  deviceName: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
  dpiX: number;
  dpiY: number;
}

export interface AgentWindowCandidate {
  processId: number;
  processName: string;
  executableName: string;
  windowHandle: string;
  title: string;
  windowRect: AgentWindowRect;
  displayRegion: AgentWindowDisplayRegion | null;
  visible: boolean;
  minimized: boolean;
  foreground: boolean;
  matchScore: number;
}

export type AgentWindowLocationSource = "native-window" | "last-known" | "system-default";

export interface AgentWindowSnapshot {
  agentId: string;
  agentName: string;
  processId: number | null;
  processName: string | null;
  windowHandle: string | null;
  windowTitle: string | null;
  windowRect: AgentWindowRect | null;
  displayRegion: AgentWindowDisplayRegion | null;
  display: Electron.Display;
  source: AgentWindowLocationSource;
  visible: boolean;
  minimized: boolean;
  updatedAt: number;
  candidates: AgentWindowCandidate[];
}

export interface AgentWindowFollowStatus {
  agentId: string;
  agentName: string;
  displayId: string;
  displayLabel: string;
  displayBounds: { x: number; y: number; width: number; height: number };
  logicalWidth: number;
  logicalHeight: number;
  pixelWidth: number;
  pixelHeight: number;
  scaleFactor: number;
  source: AgentWindowLocationSource;
  processId: number | null;
  processName: string | null;
  windowHandle: string | null;
  windowTitle: string | null;
  windowRect: AgentWindowRect | null;
  nativeDisplayRegion: AgentWindowDisplayRegion | null;
  updatedAt: number;
}

export function toAgentWindowFollowStatus(snapshot: AgentWindowSnapshot): AgentWindowFollowStatus {
  const scaleFactor = Math.max(1, snapshot.display.scaleFactor || 1, (snapshot.displayRegion?.dpiX ?? 96) / 96);
  return {
    agentId: snapshot.agentId,
    agentName: snapshot.agentName,
    displayId: String(snapshot.display.id),
    displayLabel: snapshot.display.label || String(snapshot.display.id),
    displayBounds: { ...snapshot.display.bounds },
    logicalWidth: Math.round(snapshot.display.bounds.width),
    logicalHeight: Math.round(snapshot.display.bounds.height),
    pixelWidth: Math.max(1, Math.round(snapshot.display.bounds.width * scaleFactor)),
    pixelHeight: Math.max(1, Math.round(snapshot.display.bounds.height * scaleFactor)),
    scaleFactor,
    source: snapshot.source,
    processId: snapshot.processId,
    processName: snapshot.processName,
    windowHandle: snapshot.windowHandle,
    windowTitle: snapshot.windowTitle,
    windowRect: snapshot.windowRect,
    nativeDisplayRegion: snapshot.displayRegion,
    updatedAt: snapshot.updatedAt,
  };
}

interface NativeWindowRecord {
  hwnd: string;
  pid: number;
  processName: string;
  executable: string;
  title: string;
  visible: boolean;
  minimized: boolean;
  foreground: boolean;
  rect: AgentWindowRect;
  monitor: AgentWindowDisplayRegion | null;
}

interface NativeScanResult {
  windows: NativeWindowRecord[];
}

interface LastKnownLocation {
  displayId: string;
  displayRegion: AgentWindowDisplayRegion | null;
  windowRect: AgentWindowRect | null;
  processId: number | null;
  processName: string | null;
  windowHandle: string | null;
  windowTitle: string | null;
  updatedAt: number;
}

type DisplayLike = Electron.Display;

const WINDOWS_NATIVE_SCAN_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class PenguinNativeWindowScan {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int left; public int top; public int right; public int bottom; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct MONITORINFOEX {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice;
    }

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int capacity);
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFOEX monitorInfo);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr hMonitor, int dpiType, out uint dpiX, out uint dpiY);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
}
'@

# Per-monitor-v2 keeps the native window and monitor rectangles in one stable
# coordinate space even when a high-DPI display reports a smaller logical size.
[PenguinNativeWindowScan]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
$selfPid = $PID
$foreground = [PenguinNativeWindowScan]::GetForegroundWindow()
$rows = New-Object System.Collections.Generic.List[object]
$processNames = @{}
Get-Process | ForEach-Object { $processNames[[int]$_.Id] = [string]$_.ProcessName }

[PenguinNativeWindowScan]::EnumWindows({
    param($hWnd, $lParam)
    if ($hWnd -eq [IntPtr]::Zero) { return $true }
    if (-not [PenguinNativeWindowScan]::IsWindowVisible($hWnd)) { return $true }
    $pidValue = [uint32]0
    [PenguinNativeWindowScan]::GetWindowThreadProcessId($hWnd, [ref]$pidValue) | Out-Null
    if ($pidValue -eq $selfPid) { return $true }
    $titleLength = [PenguinNativeWindowScan]::GetWindowTextLength($hWnd)
    if ($titleLength -le 0) { return $true }
    $titleBuffer = New-Object System.Text.StringBuilder ($titleLength + 1)
    [PenguinNativeWindowScan]::GetWindowText($hWnd, $titleBuffer, $titleBuffer.Capacity) | Out-Null
    $windowTitle = $titleBuffer.ToString().Trim()
    if ([string]::IsNullOrWhiteSpace($windowTitle)) { return $true }
    $windowRectNative = New-Object PenguinNativeWindowScan+RECT
    if (-not [PenguinNativeWindowScan]::GetWindowRect($hWnd, [ref]$windowRectNative)) { return $true }
    $monitorHandle = [PenguinNativeWindowScan]::MonitorFromWindow($hWnd, 2)
    $monitor = $null
    if ($monitorHandle -ne [IntPtr]::Zero) {
        $monitorInfo = New-Object PenguinNativeWindowScan+MONITORINFOEX
        $monitorInfo.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($monitorInfo)
        if ([PenguinNativeWindowScan]::GetMonitorInfo($monitorHandle, [ref]$monitorInfo)) {
            $dpiX = 96; $dpiY = 96; $dpiResult = [PenguinNativeWindowScan]::GetDpiForMonitor($monitorHandle, 0, [ref]$dpiX, [ref]$dpiY)
            if ($dpiResult -ne 0) { $dpiX = 96; $dpiY = 96 }
            $monitor = [pscustomobject]@{
                deviceName = $monitorInfo.szDevice.Trim()
                left = $monitorInfo.rcMonitor.left
                top = $monitorInfo.rcMonitor.top
                right = $monitorInfo.rcMonitor.right
                bottom = $monitorInfo.rcMonitor.bottom
                width = $monitorInfo.rcMonitor.right - $monitorInfo.rcMonitor.left
                height = $monitorInfo.rcMonitor.bottom - $monitorInfo.rcMonitor.top
                dpiX = [int]$dpiX
                dpiY = [int]$dpiY
            }
        }
    }
    $processName = if ($processNames.ContainsKey([int]$pidValue)) { [string]$processNames[[int]$pidValue] } else { '' }
    $rows.Add([pscustomobject]@{
        hwnd = ('0x{0:X}' -f $hWnd.ToInt64())
        pid = [int]$pidValue
        processName = [string]$processName
        executable = [string]$executable
        title = $windowTitle
        visible = $true
        minimized = [PenguinNativeWindowScan]::IsIconic($hWnd)
        foreground = ($hWnd -eq $foreground)
        rect = [pscustomobject]@{
            left = $windowRectNative.left
            top = $windowRectNative.top
            right = $windowRectNative.right
            bottom = $windowRectNative.bottom
            width = $windowRectNative.right - $windowRectNative.left
            height = $windowRectNative.bottom - $windowRectNative.top
        }
        monitor = $monitor
    })
    return $true
}, [IntPtr]::Zero) | Out-Null

[pscustomobject]@{ windows = @($rows) } | ConvertTo-Json -Compress -Depth 8
`;

const WINDOWS_NATIVE_SCAN_COMPILED_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class PenguinNativeWindowScanCompiled {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left; public int top; public int right; public int bottom; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct MONITORINFOEX {
        public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice;
    }
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int capacity);
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFOEX monitorInfo);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr hMonitor, int dpiType, out uint dpiX, out uint dpiY);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    private static Dictionary<string, object> Rect(RECT value) {
        var result = new Dictionary<string, object>();
        result["left"] = value.left; result["top"] = value.top; result["right"] = value.right; result["bottom"] = value.bottom;
        result["width"] = Math.Max(0, value.right - value.left); result["height"] = Math.Max(0, value.bottom - value.top);
        return result;
    }

    public static List<Dictionary<string, object>> Scan() {
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
        var rows = new List<Dictionary<string, object>>();
        var foreground = GetForegroundWindow();
        var callback = new EnumWindowsProc((hWnd, lParam) => {
            if (hWnd == IntPtr.Zero || !IsWindowVisible(hWnd)) return true;
            uint processId;
            GetWindowThreadProcessId(hWnd, out processId);
            if (processId == (uint)Process.GetCurrentProcess().Id) return true;
            var length = GetWindowTextLength(hWnd);
            if (length <= 0) return true;
            var titleBuffer = new StringBuilder(length + 1);
            GetWindowText(hWnd, titleBuffer, titleBuffer.Capacity);
            var title = titleBuffer.ToString().Trim();
            if (title.Length == 0) return true;
            RECT rect;
            if (!GetWindowRect(hWnd, out rect)) return true;

            var processName = "";
            try { processName = Process.GetProcessById((int)processId).ProcessName ?? ""; } catch { }
            Dictionary<string, object> monitor = null;
            // MONITOR_DEFAULTTONEAREST is also the documented largest-overlap
            // choice when a window intersects multiple monitors. This keeps
            // the target physical monitor independent from the primary display.
            var monitorHandle = MonitorFromWindow(hWnd, 2);
            if (monitorHandle != IntPtr.Zero) {
                var info = new MONITORINFOEX();
                info.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
                if (GetMonitorInfo(monitorHandle, ref info)) {
                    uint dpiX = 96, dpiY = 96;
                    try { if (GetDpiForMonitor(monitorHandle, 0, out dpiX, out dpiY) != 0) { dpiX = 96; dpiY = 96; } } catch { }
                    var monitorRect = info.rcMonitor;
                    monitor = Rect(monitorRect);
                    monitor["deviceName"] = (info.szDevice ?? "").Trim();
                    monitor["dpiX"] = (int)dpiX;
                    monitor["dpiY"] = (int)dpiY;
                }
            }
            var row = new Dictionary<string, object>();
            row["hwnd"] = "0x" + hWnd.ToInt64().ToString("X");
            row["pid"] = (int)processId; row["processName"] = processName; row["executable"] = "";
            row["title"] = title; row["visible"] = true; row["minimized"] = IsIconic(hWnd);
            row["foreground"] = hWnd == foreground; row["rect"] = Rect(rect); row["monitor"] = monitor;
            rows.Add(row);
            return true;
        });
        EnumWindows(callback, IntPtr.Zero);
        return rows;
    }
}
'@
[pscustomobject]@{ windows = @([PenguinNativeWindowScanCompiled]::Scan()) } | ConvertTo-Json -Compress -Depth 8
`;

function normalizeRect(value: unknown): AgentWindowRect | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const left = Number(raw.left);
  const top = Number(raw.top);
  const right = Number(raw.right);
  const bottom = Number(raw.bottom);
  if (![left, top, right, bottom].every(Number.isFinite)) return null;
  return {
    left,
    top,
    right,
    bottom,
    width: Math.max(0, Number.isFinite(Number(raw.width)) ? Number(raw.width) : right - left),
    height: Math.max(0, Number.isFinite(Number(raw.height)) ? Number(raw.height) : bottom - top),
  };
}

function normalizeNativeScan(value: unknown): NativeScanResult {
  if (!value || typeof value !== "object") return { windows: [] };
  const raw = value as Record<string, unknown>;
  const windows = Array.isArray(raw.windows) ? raw.windows : raw.windows ? [raw.windows] : [];
  return {
    windows: windows.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const row = item as Record<string, unknown>;
      const rect = normalizeRect(row.rect);
      if (!rect) return [];
      const pid = Number(row.pid);
      if (!Number.isInteger(pid) || pid <= 0) return [];
      const monitorRaw = row.monitor && typeof row.monitor === "object" ? row.monitor as Record<string, unknown> : null;
      const monitorRect = normalizeRect(monitorRaw);
      const monitor = monitorRaw && monitorRect
        ? {
            deviceName: typeof monitorRaw.deviceName === "string" ? monitorRaw.deviceName.trim() : "",
            left: monitorRect.left,
            top: monitorRect.top,
            right: monitorRect.right,
            bottom: monitorRect.bottom,
            width: monitorRect.width,
            height: monitorRect.height,
            dpiX: Math.max(1, Number(monitorRaw.dpiX) || 96),
            dpiY: Math.max(1, Number(monitorRaw.dpiY) || 96),
          }
        : null;
      return [{
        hwnd: typeof row.hwnd === "string" ? row.hwnd : "",
        pid,
        processName: typeof row.processName === "string" ? row.processName : "",
        executable: typeof row.executable === "string" ? row.executable : "",
        title: typeof row.title === "string" ? row.title : "",
        visible: row.visible !== false,
        minimized: row.minimized === true,
        foreground: row.foreground === true,
        rect,
        monitor,
      } satisfies NativeWindowRecord];
    }),
  };
}

function basename(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/");
  const file = normalized.slice(normalized.lastIndexOf("/") + 1);
  return file.replace(/\.(exe|cmd|bat|com)$/i, "").toLowerCase();
}

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function processTokens(config: AgentConfig): string[] {
  const tokens = new Set<string>();
  const command = basename(config.command);
  if (command && !["cmd", "powershell", "pwsh", "node", "npm", "npx"].includes(command)) tokens.add(command);
  switch (config.sourceApp) {
    case "codex":
      ["codex", "chatgpt", "code"].forEach((token) => tokens.add(token));
      break;
    case "claude-code":
      ["claude", "claudecode", "code"].forEach((token) => tokens.add(token));
      break;
    case "claude-desktop":
      ["claude", "claudedesktop"].forEach((token) => tokens.add(token));
      break;
    case "hermes":
      tokens.add("hermes");
      break;
    case "opencode":
      tokens.add("opencode");
      break;
    case "gemini":
      tokens.add("gemini");
      break;
    default:
      break;
  }
  return [...tokens].map(normalizeToken).filter(Boolean);
}

function intersectionArea(left: AgentWindowRect, right: AgentWindowDisplayRegion): number {
  const width = Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left));
  const height = Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top));
  return width * height;
}

export function selectLargestOverlapDisplay<T extends AgentWindowDisplayRegion>(
  windowRect: AgentWindowRect,
  displays: readonly T[],
): T | null {
  let best: T | null = null;
  let bestArea = 0;
  for (const display of displays) {
    const area = intersectionArea(windowRect, display);
    if (area > bestArea) {
      bestArea = area;
      best = display;
    }
  }
  return best;
}

function candidateScore(config: AgentConfig, row: NativeWindowRecord): number {
  const processName = normalizeToken(basename(row.processName));
  const executableName = normalizeToken(basename(row.executable));
  const tokens = processTokens(config);
  const title = normalizeToken(row.title);
  let score = 0;
  if (tokens.includes(processName) || tokens.includes(executableName)) score += 80;
  if (config.displayName && title.includes(normalizeToken(config.displayName))) score += 30;
  if (config.workingDirectory) {
    const directoryName = normalizeToken(config.workingDirectory.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "");
    if (directoryName && title.includes(directoryName)) score += 25;
  }
  if (config.sourceApp === "claude-code" && /claude/.test(title)) score += 18;
  if (config.sourceApp === "codex" && /(codex|chatgpt)/.test(title)) score += 18;
  if (row.foreground) score += 15;
  score += Math.min(10, Math.round(Math.sqrt(Math.max(0, row.rect.width * row.rect.height)) / 200));
  return score;
}

function matchesConfig(config: AgentConfig, row: NativeWindowRecord): boolean {
  const processName = normalizeToken(basename(row.processName));
  const executableName = normalizeToken(basename(row.executable));
  const tokens = processTokens(config);
  if (tokens.includes(processName) || tokens.includes(executableName)) return true;
  const title = normalizeToken(row.title);
  if (config.displayName && title.includes(normalizeToken(config.displayName))) return true;
  if (config.workingDirectory) {
    const directoryName = normalizeToken(config.workingDirectory.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "");
    if (directoryName && title.includes(directoryName)) return true;
  }
  return false;
}

function mapNativeDisplayToElectron(
  region: AgentWindowDisplayRegion,
  displays: readonly DisplayLike[],
): Electron.Display | null {
  const nativeLabel = normalizeToken(region.deviceName);
  const byLabel = displays.find((display) => normalizeToken(display.label ?? "") === nativeLabel);
  if (byLabel) return byLabel;

  // Native monitor coordinates can be physical while Electron bounds are
  // logical. Compare both the raw and DPI-normalized rectangles.
  let best: DisplayLike | null = null;
  let bestScore = -Infinity;
  for (const display of displays) {
    const scale = Math.max(1, display.scaleFactor || 1, region.dpiX / 96);
    const logical = {
      left: region.left / scale,
      top: region.top / scale,
      right: region.right / scale,
      bottom: region.bottom / scale,
    };
    const horizontal = Math.max(0, Math.min(display.bounds.x + display.bounds.width, logical.right) - Math.max(display.bounds.x, logical.left));
    const vertical = Math.max(0, Math.min(display.bounds.y + display.bounds.height, logical.bottom) - Math.max(display.bounds.y, logical.top));
    const overlap = horizontal * vertical;
    const sizePenalty = Math.abs(display.bounds.width - logical.right + logical.left) + Math.abs(display.bounds.height - logical.bottom + logical.top);
    const score = overlap * 10 - sizePenalty;
    if (score > bestScore) {
      bestScore = score;
      best = display;
    }
  }
  return best;
}

function systemDefaultDisplay(displays: readonly DisplayLike[], primaryId?: number): Electron.Display | null {
  if (displays.length === 0) return null;
  if (primaryId !== undefined) {
    const primary = displays.find((display) => display.id === primaryId);
    if (primary) return primary;
  }
  const origin = displays.find((display) => display.bounds.x <= 0 && display.bounds.x + display.bounds.width > 0 && display.bounds.y <= 0 && display.bounds.y + display.bounds.height > 0);
  return origin ?? [...displays].sort((left, right) => Math.abs(left.bounds.x) + Math.abs(left.bounds.y) - Math.abs(right.bounds.x) - Math.abs(right.bounds.y))[0] ?? null;
}

export interface AgentWindowTrackerOptions {
  initialLastKnownDisplayIds?: Record<string, string>;
  onDisplayChanged?: (agentId: string, displayId: string) => void;
}

export class AgentWindowTracker {
  private configs = new Map<string, AgentConfig>();
  private snapshots = new Map<string, AgentWindowSnapshot>();
  private lastKnown = new Map<string, LastKnownLocation>();
  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshPromise: Promise<void> | null = null;
  private disposed = false;

  constructor(private readonly options: AgentWindowTrackerOptions = {}) {
    for (const [agentId, displayId] of Object.entries(options.initialLastKnownDisplayIds ?? {})) {
      if (displayId.trim()) {
        this.lastKnown.set(agentId, {
          displayId: displayId.trim(),
          displayRegion: null,
          windowRect: null,
          processId: null,
          processName: null,
          windowHandle: null,
          windowTitle: null,
          updatedAt: Date.now(),
        });
      }
    }
  }

  setConfigs(configs: readonly AgentConfig[]): void {
    this.configs = new Map(configs.filter((config) => config.enabled !== false).map((config) => [config.id, config]));
  }

  start(): void {
    if (this.refreshTimer || this.disposed) return;
    void this.refresh();
    this.refreshTimer = setInterval(() => { void this.refresh(); }, REFRESH_INTERVAL_MS);
  }

  stop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    this.disposed = true;
  }

  async getSnapshot(agentId: string): Promise<AgentWindowSnapshot | null> {
    await this.refresh();
    return this.snapshots.get(agentId) ?? null;
  }

  getCachedSnapshot(agentId: string): AgentWindowSnapshot | null {
    return this.snapshots.get(agentId) ?? null;
  }

  async refresh(): Promise<void> {
    if (this.disposed || this.refreshPromise) return this.refreshPromise ?? Promise.resolve();
    this.refreshPromise = this.refreshInternal().finally(() => { this.refreshPromise = null; });
    return this.refreshPromise;
  }

  private async refreshInternal(): Promise<void> {
    if (this.configs.size === 0) return;
    const displays = screen.getAllDisplays();
    const fallback = systemDefaultDisplay(displays, screen.getPrimaryDisplay().id);
    if (!fallback) return;
    const scan = await scanNativeWindows();
    for (const config of this.configs.values()) {
      const candidates = scan.windows
        .filter((row) => matchesConfig(config, row))
        .map((row) => ({
          processId: row.pid,
          processName: row.processName || basename(row.executable) || "未知进程",
          executableName: basename(row.executable) || basename(row.processName),
          windowHandle: row.hwnd,
          title: row.title,
          windowRect: row.rect,
          displayRegion: row.monitor,
          visible: row.visible,
          minimized: row.minimized,
          foreground: row.foreground,
          matchScore: candidateScore(config, row),
        } satisfies AgentWindowCandidate))
        .sort((left, right) => right.matchScore - left.matchScore);
      const selected = candidates[0] ?? null;
      const currentDisplay = selected?.displayRegion ? mapNativeDisplayToElectron(selected.displayRegion, displays) : null;
      const previous = this.lastKnown.get(config.id);
      const isUsableCurrent = Boolean(selected && currentDisplay && selected.visible && !selected.minimized && selected.windowRect.width > 0 && selected.windowRect.height > 0);
      const display = isUsableCurrent ? currentDisplay! : previous ? displays.find((item) => String(item.id) === previous.displayId) ?? fallback : fallback;
      const source: AgentWindowLocationSource = isUsableCurrent ? "native-window" : previous && displays.some((item) => String(item.id) === previous.displayId) ? "last-known" : "system-default";
      if (isUsableCurrent) {
        const displayRegion = selected?.displayRegion ?? null;
        const last: LastKnownLocation = {
          displayId: String(display.id),
          displayRegion,
          windowRect: selected?.windowRect ?? null,
          processId: selected?.processId ?? null,
          processName: selected?.processName ?? null,
          windowHandle: selected?.windowHandle ?? null,
          windowTitle: selected?.title ?? null,
          updatedAt: Date.now(),
        };
        const displayChanged = previous?.displayId !== last.displayId;
        this.lastKnown.set(config.id, last);
        if (displayChanged) this.options.onDisplayChanged?.(config.id, last.displayId);
      }
      const last = this.lastKnown.get(config.id);
      this.snapshots.set(config.id, {
        agentId: config.id,
        agentName: config.displayName,
        processId: selected?.processId ?? last?.processId ?? null,
        processName: selected?.processName ?? last?.processName ?? null,
        windowHandle: selected?.windowHandle ?? last?.windowHandle ?? null,
        windowTitle: selected?.title ?? last?.windowTitle ?? null,
        windowRect: selected?.windowRect ?? last?.windowRect ?? null,
        displayRegion: selected?.displayRegion ?? last?.displayRegion ?? null,
        display,
        source,
        visible: Boolean(selected?.visible && !selected.minimized),
        minimized: Boolean(selected?.minimized),
        updatedAt: Date.now(),
        candidates,
      });
    }
  }
}

async function scanNativeWindows(): Promise<NativeScanResult> {
  if (process.platform !== "win32") return { windows: [] };
  try {
    const result = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_NATIVE_SCAN_COMPILED_SCRIPT], {
      windowsHide: true,
      timeout: NATIVE_SCAN_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    const output = result.stdout.trim();
    if (!output) return { windows: [] };
    return normalizeNativeScan(JSON.parse(output));
  } catch (error) {
    const detail = error && typeof error === "object" && "stderr" in error
      ? String((error as { stderr?: unknown }).stderr || (error as { message?: unknown }).message || error)
      : error instanceof Error ? error.message : error;
    console.warn("[AgentWindowTracker] native window scan failed", detail);
    return { windows: [] };
  }
}
