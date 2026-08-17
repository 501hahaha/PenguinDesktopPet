export type WebModelRuntimeStatus = "stopped" | "starting" | "ready" | "login_required" | "error";

export interface WebModelProvider {
  id: string;
  name: string;
  website?: string;
  authenticated: boolean;
  modelCount: number;
}

export interface WebModelModel {
  id: string;
  name?: string;
  providerId?: string;
  contextWindow?: number;
  maxOutput?: number;
}

export interface WebModelRuntimeState {
  status: WebModelRuntimeStatus;
  port: number | null;
  baseUrl: string;
  pid: number | null;
  spawnedByApp: boolean;
  lastError: string | null;
  detail: string;
  providers: WebModelProvider[];
  models: WebModelModel[];
  selectedModelId: string | null;
  updatedAt: number;
}
