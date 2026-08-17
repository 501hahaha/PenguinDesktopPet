// Alpha 宠物视频导入支持：对非 WebM 源（如带 Alpha 通道的 QuickTime MOV）
// 做安全校验，并用 ffmpeg 转换为运行时兼容的 Alpha WebM（VP9 yuva420p，
// auto-alt-ref 关闭），导入后只保留生成的 .webm，原始源文件不进入应用数据。
// 全部通过异步 child_process 调用 ffprobe/ffmpeg，避免阻塞 Electron 主进程。
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const TOOL_VERSION_TIMEOUT_MS = 10_000;
const FFPROBE_TIMEOUT_MS = 30_000;
const TRANSPARENCY_TIMEOUT_MS = 60_000;
const CONVERT_TIMEOUT_MS = 10 * 60_000;
const TRANSPARENCY_MAX_BUFFER = 32 * 1024 * 1024;

// Windows 上 PATH 之外的常见 FFmpeg 安装位置（PATH 优先）。
const WINDOWS_FFMPEG_DIRS = [
  "C:\\ffmpeg\\bin",
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links") : "",
  process.env.ChocolateyInstall ? join(process.env.ChocolateyInstall, "bin") : "C:\\ProgramData\\chocolatey\\bin",
  process.env.USERPROFILE ? join(process.env.USERPROFILE, "scoop", "shims") : "",
].filter(Boolean);

let cachedFfmpeg: string | null | undefined;
let cachedFfprobe: string | null | undefined;

export type PreparedPetStyleVideo =
  | { ok: true; kind: "webm"; totalBytes: number }
  | { ok: true; kind: "converted"; webmPath: string; totalBytes: number }
  | { ok: false; detail: string };

type VideoErrorKind = "no-ffmpeg" | "probe" | "no-alpha" | "opaque" | "decode" | "convert";

class PetStyleVideoError extends Error {
  constructor(readonly kind: VideoErrorKind, message: string) {
    super(message);
    this.name = "PetStyleVideoError";
  }
}

function missingFfmpegMessage(): string {
  return "未找到 FFmpeg，无法把 MOV 转换为 Alpha WebM。请安装 FFmpeg 并加入系统 PATH（或安装到 C:\\ffmpeg\\bin 等常见位置），然后重新导入。";
}

// 命名约定中带 Alpha 分量的像素格式都包含字母 a（yuva*/rgba/argb/bgra/abgr/
// gbrap/ya8/ayuv 等）；gray* 与 bayer* 名称里也有 a，但并没有 Alpha 通道。
function pixFmtHasAlpha(pixFmt: string): boolean {
  const name = pixFmt.toLowerCase();
  if (!name.includes("a")) return false;
  if (name.startsWith("gray") || name.startsWith("bayer")) return false;
  return true;
}

async function resolveTool(tool: "ffmpeg" | "ffprobe"): Promise<string | null> {
  const cache = tool === "ffmpeg" ? cachedFfmpeg : cachedFfprobe;
  if (cache !== undefined) return cache;
  let resolved: string | null = null;
  try {
    await execFileAsync(tool, ["-version"], { timeout: TOOL_VERSION_TIMEOUT_MS, windowsHide: true });
    resolved = tool;
  } catch {
    // 不在 PATH 中，回退到常见安装位置。
  }
  if (!resolved && process.platform === "win32") {
    const executable = `${tool}.exe`;
    for (const dir of WINDOWS_FFMPEG_DIRS) {
      const candidate = join(dir, executable);
      if (existsSync(candidate)) {
        resolved = candidate;
        break;
      }
    }
  }
  if (tool === "ffmpeg") cachedFfmpeg = resolved;
  else cachedFfprobe = resolved;
  return resolved;
}

async function probeVideoInfo(sourcePath: string): Promise<{ pixFmt: string; codecName: string }> {
  const ffprobe = await resolveTool("ffprobe");
  if (!ffprobe) throw new PetStyleVideoError("no-ffmpeg", missingFfmpegMessage());
  let stdout: string;
  try {
    const result = await execFileAsync(
      ffprobe,
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=pix_fmt,codec_name", "-of", "json", sourcePath],
      { timeout: FFPROBE_TIMEOUT_MS, windowsHide: true },
    );
    stdout = String(result.stdout);
  } catch {
    throw new PetStyleVideoError("probe", "无法读取视频信息，请确认文件是有效的视频文件。");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new PetStyleVideoError("probe", "无法读取视频信息，请确认文件是有效的视频文件。");
  }
  const streams = (parsed as { streams?: unknown }).streams;
  const stream = Array.isArray(streams)
    ? (streams[0] as { pix_fmt?: unknown; codec_name?: unknown } | undefined)
    : undefined;
  if (!stream || typeof stream.pix_fmt !== "string") {
    throw new PetStyleVideoError("probe", "文件中没有可用的视频轨道，无法作为宠物视频。");
  }
  return { pixFmt: stream.pix_fmt, codecName: typeof stream.codec_name === "string" ? stream.codec_name : "" };
}

// 解码少量缩放后的画面，确认确实存在透明像素（Alpha 通道全部为 255 的
// “纯不透明”视频不能作为 Alpha 宠物视频）。
async function verifyTransparency(sourcePath: string): Promise<void> {
  const ffmpeg = await resolveTool("ffmpeg");
  if (!ffmpeg) throw new PetStyleVideoError("no-ffmpeg", missingFfmpegMessage());
  let bytes: Buffer;
  try {
    const result = await execFileAsync(
      ffmpeg,
      [
        "-hide_banner", "-v", "error", "-i", sourcePath,
        "-vf", "scale=320:-2,format=rgba,alphaextract,fps=2",
        "-frames:v", "24", "-an", "-sn", "-dn", "-f", "rawvideo", "-",
      ],
      { timeout: TRANSPARENCY_TIMEOUT_MS, windowsHide: true, encoding: null, maxBuffer: TRANSPARENCY_MAX_BUFFER },
    );
    bytes = result.stdout;
  } catch (error) {
    if (error instanceof PetStyleVideoError) throw error;
    throw new PetStyleVideoError("decode", "无法解析视频画面，请检查文件是否完整或已损坏。");
  }
  if (bytes.length === 0) {
    throw new PetStyleVideoError("decode", "无法解析视频画面，请检查文件是否完整或已损坏。");
  }
  if (!bytes.some((value) => value !== 255)) {
    throw new PetStyleVideoError("opaque", "视频带有 Alpha 通道但画面完全不透明，不能作为 Alpha 宠物视频。请确认导出时保留了透明区域。");
  }
}

async function convertToAlphaWebm(sourcePath: string): Promise<string> {
  const ffmpeg = await resolveTool("ffmpeg");
  if (!ffmpeg) throw new PetStyleVideoError("no-ffmpeg", missingFfmpegMessage());
  const outPath = join(tmpdir(), `pet-style-alpha-${randomUUID()}.webm`);
  try {
    await execFileAsync(
      ffmpeg,
      [
        "-hide_banner", "-y", "-i", sourcePath,
        "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0",
        "-row-mt", "1", "-an", "-sn", "-dn",
        outPath,
      ],
      { timeout: CONVERT_TIMEOUT_MS, windowsHide: true },
    );
    if (!existsSync(outPath) || statSync(outPath).size <= 0) {
      throw new Error("converted file is empty");
    }
    return outPath;
  } catch (error) {
    try { rmSync(outPath, { force: true }); } catch { /* best effort cleanup */ }
    if (error instanceof PetStyleVideoError) throw error;
    throw new PetStyleVideoError("convert", "视频转换失败，请检查源文件编码或重新导出。");
  }
}

/**
 * 准备一个宠物状态视频源：
 * - .webm 保持原有行为，直接由调用方复制；
 * - .mov 先校验是否真的带 Alpha 通道（ffprobe 探测像素格式 + 解码抽查透明像素），
 *   再转换为 Alpha WebM 并返回临时文件路径，失败时自行清理临时文件；
 * - 其它扩展名直接拒绝。
 */
export async function preparePetStyleVideo(sourcePath: string): Promise<PreparedPetStyleVideo> {
  const extension = sourcePath.toLowerCase().slice(sourcePath.lastIndexOf("."));
  if (extension === ".webm") {
    return { ok: true, kind: "webm", totalBytes: statSync(sourcePath).size };
  }
  if (extension !== ".mov") {
    return { ok: false, detail: `仅支持带 Alpha 通道的 WebM 或 MOV 文件${extension ? `（检测到 ${extension}）` : "。"}。` };
  }
  try {
    const info = await probeVideoInfo(sourcePath);
    if (!pixFmtHasAlpha(info.pixFmt)) {
      const codecHint = info.codecName ? `（编码 ${info.codecName}，像素格式 ${info.pixFmt}）` : "";
      throw new PetStyleVideoError(
        "no-alpha",
        `未检测到 Alpha 通道${codecHint}，该视频不含透明信息，不能作为 Alpha 宠物视频。请导出带透明通道的视频（如 QuickTime PNG/Animation 编码的 MOV）。`,
      );
    }
    await verifyTransparency(sourcePath);
    const webmPath = await convertToAlphaWebm(sourcePath);
    return { ok: true, kind: "converted", webmPath, totalBytes: statSync(sourcePath).size };
  } catch (error) {
    if (error instanceof PetStyleVideoError) return { ok: false, detail: error.message };
    // 不记录错误消息本身：execFile 的错误消息可能包含源文件路径。
    console.warn(
      "Unable to prepare pet style video.",
      error instanceof Error ? `${error.name} ${(error as { code?: unknown }).code ?? ""}`.trim() : typeof error,
    );
    return { ok: false, detail: "无法处理该视频文件，请检查文件是否有效。" };
  }
}
