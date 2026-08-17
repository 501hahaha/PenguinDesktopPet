import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

function splitNullSeparated(value) {
  return value.split("\0").map((item) => item.trim()).filter(Boolean);
}

function candidateFiles() {
  const tracked = splitNullSeparated(git("ls-files", "-z"));
  const untracked = splitNullSeparated(git("ls-files", "-z", "--others", "--exclude-standard"));
  return [...new Set([...tracked, ...untracked])].sort();
}

function readTextFile(file) {
  const absolutePath = resolve(root, file);
  if (!existsSync(absolutePath) || !lstatSync(absolutePath).isFile()) return null;
  const extension = extname(file).toLowerCase();
  const textExtensions = new Set([
    ".cjs", ".css", ".html", ".js", ".json", ".mjs", ".md", ".ps1", ".sh", ".ts", ".tsx", ".txt", ".yml", ".yaml",
  ]);
  if (!textExtensions.has(extension)) return null;
  const buffer = readFileSync(absolutePath);
  if (buffer.includes(0)) return null;
  return buffer.toString("utf8");
}

const findings = [];
const sensitiveFileName = /(^|\/)(?:\.env(?:\.[^/]+)?|(?:credentials?|secrets?|tokens?|sessions?|cookies?)\.(?:json|txt|yaml|yml)|[^/]+\.(?:pem|key|p12|pfx|jks|keystore|db|sqlite|sqlite3|log|bak|backup|jsonl)|(?:release|diagnostics?|diag-export|screenshots?|display-check(?:-[^/]+)?)(?:\/|$)|(?:actual-primary-fullscreen|after-prompt-sent|current-page-screenshot|current-primary-fullscreen|external-agent-screen[^/]*|external-fullscreen[^/]*|full-screen[^/]*|fullscreen[^/]*|primary-screen-screenshot|verify-chatgpt-send)\.(?:png|jpe?g))/i;
const personalPathPatterns = [
  /[A-Za-z]:\\+Users\\+(?!\.\.\.|<)[A-Za-z0-9][A-Za-z0-9._-]{1,}(?:\\|$)/,
  /\/Users\/(?!\.\.\.|<)[A-Za-z0-9][A-Za-z0-9._-]{1,}(?:\/|$)/,
  /\/home\/(?!\.\.\.|<)[A-Za-z0-9][A-Za-z0-9._-]{1,}(?:\/|$)/,
];
const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const privateKeyPattern = /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/;
const tokenPattern = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|AIza[A-Za-z0-9_-]{20,})\b/;
const assignedSecretPattern = /\b(?:api[_-]?key|app[_-]?secret|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\b\s*[:=]\s*["'`][^"'`\r\n]{8,}["'`]/i;

function addFinding(file, reason) {
  findings.push(`${file}: ${reason}`);
}

let files;
try {
  files = candidateFiles();
} catch (error) {
  console.error("Public release check could not read the Git file list.");
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

for (const file of files) {
  const normalized = file.replaceAll("\\", "/");
  if (sensitiveFileName.test(normalized) && !normalized.endsWith(".env.example")) {
    addFinding(file, "looks like local credentials, runtime data, diagnostics, backups, or a release artifact");
  }

  const content = readTextFile(file);
  if (content === null) continue;
  if (personalPathPatterns.some((pattern) => pattern.test(content))) addFinding(file, "contains a concrete personal home/project path");
  if (emailPattern.test(content)) addFinding(file, "contains an email address; use a placeholder such as <SECURITY_CONTACT>");
  if (privateKeyPattern.test(content)) addFinding(file, "contains a private-key header");
  if (tokenPattern.test(content)) addFinding(file, "contains a token-shaped value");
  if (assignedSecretPattern.test(content)) addFinding(file, "contains a likely assigned secret value");
}

const trackedIgnored = splitNullSeparated(git("ls-files", "-z", "-ci", "--exclude-standard"));
for (const file of trackedIgnored) addFinding(file, "is tracked even though Git ignores it");

const uniqueFindings = [...new Set(findings)].sort();
if (uniqueFindings.length > 0) {
  console.error("Public release check failed. Review these files before publishing:");
  for (const finding of uniqueFindings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log(`Public release check passed for ${files.length} repository files.`);
