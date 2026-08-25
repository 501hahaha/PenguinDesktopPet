import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { memoryTextSimilarity } from "./MemoryRanker";

const MAX_FILE_CHARS = 18_000;
const MAX_CONTEXT_CHARS = 5_000;

interface ProjectMemorySection {
  file: string;
  heading: string;
  text: string;
}

function sanitizeProjectText(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/(?:api[_ -]?key|access[_ -]?key|secret|password|passwd|token|bearer|authorization)\s*[:=]\s*[^\s,;]+/gi, "credential=[redacted]")
    .replace(/(?:[A-Z]:[\\/][^\s)]+|\\\\[^\s)]+|\/(?:Users|home|root|var|tmp)\/[^\s)]+)/g, "[path]")
    .replace(/\s+/g, " ")
    .trim();
}

function sectionsForFile(file: string): ProjectMemorySection[] {
  if (!existsSync(file)) return [];
  try {
    const text = readFileSync(file, "utf8").slice(0, MAX_FILE_CHARS);
    const chunks = text.split(/(?=^#{1,3}\s)/m).map((chunk) => chunk.trim()).filter(Boolean);
    return chunks.map((chunk, index) => {
      const heading = chunk.match(/^#{1,3}\s+(.+)$/m)?.[1]?.trim() || `section-${index + 1}`;
      return { file, heading: heading.slice(0, 100), text: sanitizeProjectText(chunk).slice(0, 1_600) };
    }).filter((section) => section.text.length >= 20);
  } catch {
    return [];
  }
}

function candidateFiles(workspacePath: string): string[] {
  const initial = resolve(workspacePath);
  const result: string[] = [];
  let current = initial;
  for (let depth = 0; depth < 4; depth += 1) {
    result.push(join(current, "AGENTS.md"), join(current, "PROJECT_MEMORY.md"));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return [...new Set(result)];
}

/** Loads only bounded, relevant project rules; chat text and credentials are never read here. */
export function projectMemoryContext(query: string, workspacePath?: string, limit = 4): string {
  if (!workspacePath?.trim()) return "";
  const sections = candidateFiles(workspacePath).flatMap(sectionsForFile);
  if (sections.length === 0) return "";
  const ranked = sections
    .map((section, index) => ({ section, score: memoryTextSimilarity(query, section.text) + Math.max(0, 0.01 - index * 0.0001) }))
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(1, Math.min(8, limit)));
  let remaining = MAX_CONTEXT_CHARS;
  const selected: string[] = [];
  for (const { section } of ranked) {
    if (remaining <= 0) break;
    const text = section.text.slice(0, remaining);
    selected.push(`[${section.file.endsWith("AGENTS.md") ? "AGENTS" : "PROJECT_MEMORY"} · ${section.heading}]\n${text}`);
    remaining -= text.length;
  }
  return selected.length > 0
    ? `[项目级记忆：仅用于遵守当前项目架构与开发约束；如与当前消息冲突，以当前消息和真实检查为准]\n${selected.join("\n\n")}`
    : "";
}

export default projectMemoryContext;
