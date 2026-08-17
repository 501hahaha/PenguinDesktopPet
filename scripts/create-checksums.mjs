import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const releaseDirectory = resolve(root, process.argv[2] ?? "release");
const outputName = "SHA256SUMS.txt";

function publishableFiles(directory) {
  const extensions = new Set([".7z", ".appimage", ".deb", ".dmg", ".exe", ".msi", ".rpm", ".zip"]);
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== outputName && extensions.has(entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase()))
    .map((entry) => join(directory, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

if (!existsSync(releaseDirectory) || !lstatSync(releaseDirectory).isDirectory()) {
  console.error(`Checksum generation requires a release directory: ${releaseDirectory}`);
  process.exit(1);
}

const files = publishableFiles(releaseDirectory);
if (files.length === 0) {
  console.error(`No release artifacts found in ${releaseDirectory}. Build a package before generating checksums.`);
  process.exit(1);
}

const lines = files.map((file) => {
  const digest = createHash("sha256").update(readFileSync(file)).digest("hex");
  return `${digest}  ${file.slice(releaseDirectory.length + 1).replaceAll("\\", "/")}`;
});
writeFileSync(join(releaseDirectory, outputName), `${lines.join("\n")}\n`, "utf8");
console.log(`Wrote ${outputName} for ${files.length} artifact(s) in ${releaseDirectory}.`);
