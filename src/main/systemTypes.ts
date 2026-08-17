import type { CcSwitchCurrentConfig } from "../agents/types";

export type { CcSwitchCurrentConfig } from "../agents/types";

export type CcSwitchTargetId = "claude-code" | "codex";

export type CcSwitchAppType =
  | "claude-code"
  | "claude-desktop"
  | "codex"
  | "gemini"
  | "opencode"
  | "openclaw"
  | "hermes"
  | "unknown";

export type CcSwitchAgentSyncState = "synced" | "stale" | "conflict" | "unavailable";

export type CcSwitchExecutionSupport = "supported" | "metadata-only" | "needs-login";

export interface CcSwitchAgentProfile {
  sourceId: string;
  app: CcSwitchAppType;
  displayName: string;
  iconKey: string;
  iconColor: string | null;
  currentConfig: CcSwitchCurrentConfig | null;
  executionSupport: CcSwitchExecutionSupport;
  syncState: CcSwitchAgentSyncState;
  detail: string;
}

export type CcSwitchTargetState = "not-found" | "detected" | "available" | "error";

export interface CcSwitchTargetStatus {
  id: CcSwitchTargetId;
  label: string;
  state: CcSwitchTargetState;
  provider: string | null;
  model: string | null;
  baseUrlHost: string | null;
  lastChangedAt: number | null;
  detail: string;
}

export interface CcSwitchStatus {
  enabled: boolean;
  state: "disabled" | "not-found" | "detected" | "available" | "error";
  dataDirectoryDetected: boolean;
  targets: CcSwitchTargetStatus[];
  profiles: CcSwitchAgentProfile[];
  detail: string;
  updatedAt: number;
}

export interface CcSwitchImportResult {
  ok: boolean;
  detail: string;
  boundCount: number;
  skippedCount: number;
}

export type UpdateCheckState = "not-configured" | "checking" | "current" | "available" | "error";

export interface UpdateAssetSummary {
  kind: "nsis" | "portable";
  platform: "win32";
  arch: "x64";
  sizeBytes: number | null;
  sha256: string;
  mirrorAvailable: boolean;
}

export interface UpdateCheckResult {
  state: Exclude<UpdateCheckState, "checking">;
  currentVersion: string;
  latestVersion: string | null;
  publishedAt: string | null;
  releaseNotes: string[];
  releasePageUrl: string | null;
  assets: UpdateAssetSummary[];
  checkedAt: number | null;
  detail: string;
}
