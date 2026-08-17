import { safeStorage } from "electron";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface FeishuCredential {
  appSecret: string;
}

interface CredentialFile {
  version: 1;
  entries: Record<string, string>;
}

function feishuCredentialId(accountId: string): string {
  return `feishu-${createHash("sha256").update(resolve(accountId).toLowerCase()).digest("hex").slice(0, 16)}`;
}

export class FeishuCredentialStore {
  constructor(private readonly filePath: string) {}

  get available(): boolean {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  load(accountId: string): FeishuCredential | null {
    if (!this.available) return null;
    const encrypted = this.read().entries[feishuCredentialId(accountId)];
    if (!encrypted) return null;
    try {
      const parsed = JSON.parse(safeStorage.decryptString(Buffer.from(encrypted, "base64"))) as Partial<FeishuCredential>;
      return typeof parsed.appSecret === "string" && parsed.appSecret.trim()
        ? { appSecret: parsed.appSecret }
        : null;
    } catch {
      return null;
    }
  }

  save(accountId: string, credential: FeishuCredential): boolean {
    if (!this.available || !credential.appSecret.trim()) return false;
    try {
      const file = this.read();
      file.entries[feishuCredentialId(accountId)] = safeStorage
        .encryptString(JSON.stringify({ appSecret: credential.appSecret }))
        .toString("base64");
      this.write(file);
      return true;
    } catch {
      return false;
    }
  }

  remove(accountId: string): void {
    if (!existsSync(this.filePath)) return;
    try {
      const file = this.read();
      delete file.entries[feishuCredentialId(accountId)];
      this.write(file);
    } catch {
      // Credential removal is best effort.
    }
  }

  private read(): CredentialFile {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<CredentialFile>;
      if (parsed.version === 1 && parsed.entries && typeof parsed.entries === "object") {
        return { version: 1, entries: { ...parsed.entries } };
      }
    } catch {
      // Missing or corrupt files are treated as empty stores.
    }
    return { version: 1, entries: {} };
  }

  private write(file: CredentialFile): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    try {
      if (existsSync(this.filePath)) unlinkSync(this.filePath);
      renameSync(temporaryPath, this.filePath);
    } catch (error) {
      try {
        if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
      } catch {
        // Preserve the original write error.
      }
      throw error;
    }
  }
}
