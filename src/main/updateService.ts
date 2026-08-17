import type { UpdateAssetSummary, UpdateCheckResult } from "./systemTypes";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:") return null;
    url.search = "";
    url.hash = "";
    return url.toString().slice(0, 500);
  } catch {
    return null;
  }
}

function versionParts(value: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  if (!a || !b) return 0;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function textArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    .map((item) => item.trim().slice(0, 240))
    .slice(0, 5);
}

function assetSummary(value: unknown): UpdateAssetSummary | null {
  if (!isRecord(value)) return null;
  const kind = value.kind === "portable" || value.kind === "nsis" ? value.kind : null;
  const sha256 = typeof value.sha256 === "string" && /^[a-f0-9]{64}$/i.test(value.sha256.trim())
    ? value.sha256.trim().toLowerCase()
    : null;
  const downloadUrl = safeHttpsUrl(value.downloadUrl);
  if (!kind || !sha256 || !downloadUrl || value.platform !== "win32" || value.arch !== "x64") return null;
  const mirrorUrl = safeHttpsUrl(value.mirrorUrl);
  const sizeBytes = typeof value.sizeBytes === "number" && Number.isSafeInteger(value.sizeBytes) && value.sizeBytes > 0
    ? value.sizeBytes
    : null;
  return { kind, platform: "win32", arch: "x64", sizeBytes, sha256, mirrorAvailable: Boolean(mirrorUrl) };
}

function manifestResult(currentVersion: string, manifest: UnknownRecord): UpdateCheckResult | null {
  const latestVersion = typeof manifest.latestVersion === "string" ? manifest.latestVersion.trim() : "";
  const releasePageUrl = safeHttpsUrl(manifest.releasePageUrl);
  if (manifest.product !== "penguin-desktop-pet" || !versionParts(latestVersion)) return null;
  const assets = Array.isArray(manifest.assets)
    ? manifest.assets.map(assetSummary).filter((asset): asset is UpdateAssetSummary => Boolean(asset)).slice(0, 2)
    : [];
  const comparison = compareVersions(latestVersion, currentVersion);
  return {
    state: comparison > 0 ? "available" : "current",
    currentVersion,
    latestVersion,
    publishedAt: typeof manifest.publishedAt === "string" ? manifest.publishedAt.slice(0, 40) : null,
    releaseNotes: textArray(manifest.releaseNotes),
    releasePageUrl,
    assets,
    checkedAt: Date.now(),
    detail: comparison > 0 ? "发现新版本，请确认后打开下载页" : "当前已是最新版本",
  };
}

function manifestUrls(): string[] {
  return [process.env.PENGUIN_UPDATE_MANIFEST_URL, process.env.PENGUIN_UPDATE_MIRROR_MANIFEST_URL]
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    .map((value) => safeHttpsUrl(value))
    .filter((value): value is string => Boolean(value))
    .filter((value, index, values) => values.indexOf(value) === index);
}

export async function checkForUpdate(currentVersion: string): Promise<UpdateCheckResult> {
  const urls = manifestUrls();
  if (urls.length === 0) {
    return {
      state: "not-configured",
      currentVersion,
      latestVersion: null,
      publishedAt: null,
      releaseNotes: [],
      releasePageUrl: null,
      assets: [],
      checkedAt: null,
      detail: "更新源尚未配置；正式发布地址确认后再启用检查",
    };
  }

  let lastError = "更新清单暂不可用";
  for (const url of urls) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(8_000), headers: { accept: "application/json" } });
      if (!response.ok) {
        lastError = `更新清单请求失败（${response.status}）`;
        continue;
      }
      const payload = await response.json() as unknown;
      const result = isRecord(payload) ? manifestResult(currentVersion, payload) : null;
      if (result) return result;
      lastError = "更新清单格式不受支持";
    } catch {
      lastError = "更新清单请求失败，请稍后重试";
    }
  }
  return {
    state: "error",
    currentVersion,
    latestVersion: null,
    publishedAt: null,
    releaseNotes: [],
    releasePageUrl: null,
    assets: [],
    checkedAt: Date.now(),
    detail: lastError,
  };
}
