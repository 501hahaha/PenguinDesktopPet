import { safeStorage } from "electron";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

interface QQCredential {
  clientSecret?: string;
  accessToken?: string;
}

interface CredentialFile {
  version: 1;
  entries: Record<string, string>;
}

export function qqCredentialId(accountId: string): string {
  return `qq-${createHash("sha256").update(resolve(accountId).toLowerCase()).digest("hex").slice(0, 16)}`;
}

export class QQCredentialStore {
  constructor(private readonly filePath: string) {}

  get available(): boolean {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  load(accountId: string): QQCredential | null {
    if (!this.available) return null;
    const encrypted = this.read().entries[qqCredentialId(accountId)];
    if (!encrypted) return null;
    try {
      const parsed = JSON.parse(safeStorage.decryptString(Buffer.from(encrypted, "base64"))) as QQCredential;
      if (!parsed.clientSecret && !parsed.accessToken) return null;
      return {
        clientSecret: typeof parsed.clientSecret === "string" ? parsed.clientSecret : undefined,
        accessToken: typeof parsed.accessToken === "string" ? parsed.accessToken : undefined,
      };
    } catch {
      return null;
    }
  }

  save(accountId: string, credential: QQCredential): boolean {
    if (!this.available || (!credential.clientSecret && !credential.accessToken)) return false;
    try {
      const file = this.read();
      file.entries[qqCredentialId(accountId)] = safeStorage
        .encryptString(JSON.stringify(credential))
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
      delete file.entries[qqCredentialId(accountId)];
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

export type { QQCredential };
