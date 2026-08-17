import { desktopCapturer, screen } from "electron";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentWindowSnapshot } from "./AgentWindowTracker";

export interface CaptureDisplayLike {
  id: number | string;
  label?: string;
  bounds: { x: number; y: number; width: number; height: number };
  scaleFactor?: number;
}

export interface DesktopCaptureDisplay {
  id: string;
  label: string;
  primary: boolean;
  width: number;
  height: number;
  pixelWidth: number;
  pixelHeight: number;
  scaleFactor: number;
}

export interface DesktopCaptureDiagnostics {
  agentName: string;
  displayId: string;
  displayLabel: string;
  displayRegion: { x: number; y: number; width: number; height: number };
  nativeDisplayRegion: AgentWindowSnapshot["displayRegion"];
  logicalWidth: number;
  logicalHeight: number;
  pixelWidth: number;
  pixelHeight: number;
  scaleFactor: number;
  source: "native-window" | "last-known" | "system-default";
  compositeSource: boolean;
  capturedAt: string;
}

let lastCaptureDiagnostics: DesktopCaptureDiagnostics | null = null;

export function getLastCaptureDiagnostics(): DesktopCaptureDiagnostics | null {
  return lastCaptureDiagnostics;
}

interface PixelSize {
  width: number;
  height: number;
}

interface SourceSelection {
  source: Electron.DesktopCapturerSource;
  composite: boolean;
}

export function resolveSystemDefaultDisplay<T extends CaptureDisplayLike>(
  displays: readonly T[],
  primaryId?: number | string,
): T | null {
  if (displays.length === 0) return null;
  if (primaryId !== undefined) {
    const primary = displays.find((display) => String(display.id) === String(primaryId));
    if (primary) return primary;
  }
  const originDisplay = displays.find((display) => (
    display.bounds.x <= 0
    && display.bounds.x + display.bounds.width > 0
    && display.bounds.y <= 0
    && display.bounds.y + display.bounds.height > 0
  ));
  if (originDisplay) return originDisplay;
  return [...displays].sort((left, right) => {
    const leftDistance = Math.abs(left.bounds.x) + Math.abs(left.bounds.y);
    const rightDistance = Math.abs(right.bounds.x) + Math.abs(right.bounds.y);
    if (leftDistance !== rightDistance) return leftDistance - rightDistance;
    const leftArea = left.bounds.width * left.bounds.height;
    const rightArea = right.bounds.width * right.bounds.height;
    return rightArea - leftArea;
  })[0] ?? null;
}

export function getSystemDefaultDisplay(): Electron.Display {
  const displays = screen.getAllDisplays();
  return screen.getPrimaryDisplay() ?? resolveSystemDefaultDisplay(displays) ?? displays[0];
}

export function selectCaptureDisplay<T extends CaptureDisplayLike>(
  displays: readonly T[],
  requestedId = "",
  primaryId?: number | string,
): T | null {
  if (displays.length === 0) return null;
  const requested = requestedId.trim();
  if (requested) {
    const selected = displays.find((display) => String(display.id) === requested);
    if (selected) return selected;
  }
  return resolveSystemDefaultDisplay(displays, primaryId) ?? displays[0] ?? null;
}

function displayPixelSize(display: CaptureDisplayLike, scaleFactorOverride?: number): PixelSize {
  const scaleFactor = Number.isFinite(scaleFactorOverride) && (scaleFactorOverride ?? 0) > 0
    ? scaleFactorOverride!
    : Number.isFinite(display.scaleFactor) && (display.scaleFactor ?? 0) > 0
      ? display.scaleFactor!
      : 1;
  return {
    width: Math.max(1, Math.round(display.bounds.width * scaleFactor)),
    height: Math.max(1, Math.round(display.bounds.height * scaleFactor)),
  };
}

function displaySummary(display: CaptureDisplayLike, primaryId: number | string): DesktopCaptureDisplay {
  const scaleFactor = Number.isFinite(display.scaleFactor) && (display.scaleFactor ?? 0) > 0
    ? display.scaleFactor!
    : 1;
  const size = displayPixelSize(display);
  return {
    id: String(display.id),
    label: display.label?.trim() || `显示器 ${String(display.id)}`,
    primary: String(display.id) === String(primaryId),
    width: Math.round(display.bounds.width),
    height: Math.round(display.bounds.height),
    pixelWidth: size.width,
    pixelHeight: size.height,
    scaleFactor,
  };
}

function getVirtualDesktopBounds(displays: readonly CaptureDisplayLike[]): Electron.Rectangle {
  const left = Math.min(...displays.map((display) => display.bounds.x));
  const top = Math.min(...displays.map((display) => display.bounds.y));
  const right = Math.max(...displays.map((display) => display.bounds.x + display.bounds.width));
  const bottom = Math.max(...displays.map((display) => display.bounds.y + display.bounds.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function isExactSize(size: Electron.Size, expected: PixelSize): boolean {
  return size.width === expected.width && size.height === expected.height;
}

function selectDesktopCaptureSource(
  sources: readonly Electron.DesktopCapturerSource[],
  displays: readonly Electron.Display[],
  display: Electron.Display,
  scaleFactorOverride?: number,
): SourceSelection | null {
  const displayId = String(display.id);
  const expectedSize = displayPixelSize(display, scaleFactorOverride);
  const exact = sources.find((candidate) => candidate.display_id === displayId);
  if (exact) return { source: exact, composite: false };
  const byName = sources.find((candidate) => Boolean(display.label && candidate.name === display.label));
  if (byName) return { source: byName, composite: false };
  const exactSizeMatches = sources.filter((candidate) => isExactSize(candidate.thumbnail.getSize(), expectedSize));
  if (exactSizeMatches.length === 1) return { source: exactSizeMatches[0], composite: false };
  if (sources.length === 1) return { source: sources[0], composite: true };
  const displayIndex = displays.findIndex((candidate) => candidate.id === display.id);
  if (displayIndex >= 0 && displayIndex < sources.length) {
    const indexed = sources[displayIndex];
    return {
      source: indexed,
      composite: !isExactSize(indexed.thumbnail.getSize(), expectedSize),
    };
  }
  return sources[0] ? { source: sources[0], composite: true } : null;
}

function cropCompositeSourceToDisplay(
  image: Electron.NativeImage,
  display: Electron.Display,
  displays: readonly Electron.Display[],
  scaleFactorOverride?: number,
): Electron.NativeImage {
  const virtualBounds = getVirtualDesktopBounds(displays);
  const size = image.getSize();
  const scaleX = size.width / Math.max(1, virtualBounds.width);
  const scaleY = size.height / Math.max(1, virtualBounds.height);
  const x = Math.max(0, Math.round((display.bounds.x - virtualBounds.x) * scaleX));
  const y = Math.max(0, Math.round((display.bounds.y - virtualBounds.y) * scaleY));
  const width = Math.max(1, Math.round(display.bounds.width * scaleX));
  const height = Math.max(1, Math.round(display.bounds.height * scaleY));
  const safeWidth = Math.min(width, Math.max(1, size.width - x));
  const safeHeight = Math.min(height, Math.max(1, size.height - y));
  const cropped = image.crop({ x, y, width: safeWidth, height: safeHeight });
  const expected = displayPixelSize(display, scaleFactorOverride);
  const croppedSize = cropped.getSize();
  if (croppedSize.width === expected.width && croppedSize.height === expected.height) return cropped;
  return cropped.resize({ width: expected.width, height: expected.height, quality: "best" });
}

export function listDesktopCaptureDisplays(): DesktopCaptureDisplay[] {
  const primary = getSystemDefaultDisplay();
  return screen.getAllDisplays().map((display) => displaySummary(display, primary.id));
}

export async function captureDesktopScreenshot(preferredDisplayId = "", agentSnapshot: AgentWindowSnapshot | null = null): Promise<string> {
  void preferredDisplayId;
  const displays = screen.getAllDisplays();
  const primary = getSystemDefaultDisplay();
  // An Agent snapshot is authoritative. If no Agent snapshot exists, the only
  // allowed fallback is the operating-system primary display.
  const display = agentSnapshot?.display ?? primary;
  if (!display) throw new Error("未找到可用的显示器");

  const targetScaleFactor = Math.max(
    Number.isFinite(display.scaleFactor) && display.scaleFactor > 0 ? display.scaleFactor : 1,
    Number.isFinite(agentSnapshot?.displayRegion?.dpiX) && (agentSnapshot?.displayRegion?.dpiX ?? 0) > 0
      ? (agentSnapshot?.displayRegion?.dpiX ?? 96) / 96
      : 1,
  );
  const requestedSize = displayPixelSize(display, targetScaleFactor);
  const virtualBounds = getVirtualDesktopBounds(displays);
  const maxScaleFactor = Math.max(
    ...displays.map((candidate) => Number.isFinite(candidate.scaleFactor) && candidate.scaleFactor > 0 ? candidate.scaleFactor : 1),
  );
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: {
      width: Math.max(requestedSize.width, Math.round(virtualBounds.width * maxScaleFactor)),
      height: Math.max(requestedSize.height, Math.round(virtualBounds.height * maxScaleFactor)),
    },
  });
  const selection = selectDesktopCaptureSource(sources, displays, display, targetScaleFactor);
  if (!selection || selection.source.thumbnail.isEmpty()) {
    throw new Error(`无法获取“${display.label || String(display.id)}”的完整桌面画面，请刷新显示器列表后重试`);
  }
  const image = selection.composite
    ? cropCompositeSourceToDisplay(selection.source.thumbnail, display, displays, targetScaleFactor)
    : selection.source.thumbnail;
  const actualSize = image.getSize();
  if (actualSize.width <= 0 || actualSize.height <= 0) {
    throw new Error(`“${display.label || String(display.id)}”返回了空截图`);
  }
  const diagnostics: DesktopCaptureDiagnostics = {
    agentName: agentSnapshot?.agentName || "系统默认",
    displayId: String(display.id),
    displayLabel: display.label || String(display.id),
    displayRegion: { ...display.bounds },
    nativeDisplayRegion: agentSnapshot?.displayRegion ?? null,
    logicalWidth: Math.round(display.bounds.width),
    logicalHeight: Math.round(display.bounds.height),
    pixelWidth: requestedSize.width,
    pixelHeight: requestedSize.height,
    scaleFactor: targetScaleFactor,
    source: agentSnapshot?.source ?? "system-default",
    compositeSource: selection.composite,
    capturedAt: new Date().toISOString(),
  };
  lastCaptureDiagnostics = diagnostics;
  console.info("[DesktopCapture] target", JSON.stringify(diagnostics));
  const outputPath = join(tmpdir(), `penguin-desktop-${process.pid}-${Date.now()}.png`);
  await writeFile(outputPath, image.toPNG());
  return outputPath;
}
