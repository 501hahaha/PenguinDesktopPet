import { createWriteStream } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export type OutboundMediaKind = "image" | "file";

export interface PreparedOutboundMedia {
  source: string;
  fileName: string;
  path: string;
  cleanup: () => Promise<void>;
}

export function normalizeOutboundMediaSource(source: string): string {
  let value = source.trim().replace(/^["'`]|["'`]$/g, "");
  const markdownImage = value.match(/^!\[[^\]]*\]\(\s*(.*?)\s*\)$/s);
  if (markdownImage?.[1]) value = markdownImage[1].trim().replace(/^["'`]|["'`]$/g, "");
  const markdownLink = value.match(/^\[[^\]]*\]\(\s*(.*?)\s*\)$/s);
  if (markdownLink?.[1]) value = markdownLink[1].trim().replace(/^["'`]|["'`]$/g, "");
  const urlMatch = value.match(/https?:\/\/[^\s<>()\]}"']+/i);
  if (urlMatch?.[0]) return urlMatch[0].replace(/[),.;!?，。；！？]+$/g, "");
  return value;
}

export function inferOutboundMediaFileName(
  source: string,
  kind: OutboundMediaKind,
  preferredName = "",
): string {
  const preferred = preferredName.trim();
  if (preferred) return preferred;
  const normalized = normalizeOutboundMediaSource(source);
  const localName = basename(normalized);
  if (localName && localName !== "." && localName !== ".." && !/^[a-z]+:$/i.test(localName)) return localName;
  if (/^https?:\/\//i.test(normalized)) {
    try {
      const urlName = basename(new URL(normalized).pathname);
      if (urlName) return urlName;
    } catch {
      return kind === "image" ? "penguin-image" : "penguin-file";
    }
  }
  return kind === "image" ? "penguin-image" : "penguin-file";
}

export async function prepareOutboundMediaSource(
  source: string,
  kind: OutboundMediaKind,
  preferredName = "",
): Promise<PreparedOutboundMedia> {
  const normalized = normalizeOutboundMediaSource(source);
  if (!normalized) throw new Error("媒体路径或 URL 为空");
  if (/^https?:\/\//i.test(normalized)) {
    const response = await fetch(normalized, {
      signal: AbortSignal.timeout(45_000),
      redirect: "follow",
    });
    if (!response.ok || !response.body) {
      throw new Error(`下载媒体失败（HTTP ${response.status}）`);
    }
    const tempDir = await mkdtemp(join(tmpdir(), "penguin-media-"));
    const fileName = inferOutboundMediaFileName(normalized, kind, preferredName);
    const extension = extname(fileName);
    const targetName = extension ? fileName : `${fileName}${kind === "image" ? ".png" : ""}`;
    const targetPath = join(tempDir, targetName);
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(targetPath));
    return {
      source: normalized,
      fileName: targetName,
      path: targetPath,
      cleanup: () => rm(tempDir, { recursive: true, force: true }),
    };
  }
  await access(normalized);
  return {
    source: normalized,
    fileName: inferOutboundMediaFileName(normalized, kind, preferredName),
    path: normalized,
    cleanup: async () => undefined,
  };
}
