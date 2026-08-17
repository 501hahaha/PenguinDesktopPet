import { safeStorage } from "electron";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { WeChatSession } from "./iLinkClient";

interface CredentialFile {
  version: 1;
  entries: Record<string, string>;
}

export function credentialId(tokenFile: string): string {
  const normalizedPath = resolve(tokenFile).replaceAll("\\", "/").toLowerCase();
  return `wechat-${createHash("sha256").update(normalizedPath).digest("hex").slice(0, 16)}`;
}

export class WeChatCredentialStore {
  constructor(private readonly filePath: string) {}

  get available(): boolean {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  load(tokenFile: string): WeChatSession | null {
    if (!this.available) return null;
    const encrypted = this.read().entries[credentialId(tokenFile)];
    if (!encrypted) return null;

    try {
      const raw = safeStorage.decryptString(Buffer.from(encrypted, "base64"));
      const parsed = JSON.parse(raw) as Partial<WeChatSession>;
      if (typeof parsed.token !== "string" || typeof parsed.baseUrl !== "string") return null;
      return {
        token: parsed.token,
        baseUrl: parsed.baseUrl,
        accountId: parsed.accountId ?? "",
        userId: parsed.userId ?? "",
      };
    } catch {
      return null;
    }
  }

  save(tokenFile: string, session: WeChatSession): boolean {
    if (!this.available) return false;

    try {
      const file = this.read();
      const encrypted = safeStorage.encryptString(JSON.stringify(session)).toString("base64");
      file.entries[credentialId(tokenFile)] = encrypted;
      this.write(file);
      return true;
    } catch {
      return false;
    }
  }

  remove(tokenFile: string): void {
    if (!existsSync(this.filePath)) return;
    try {
      const file = this.read();
      delete file.entries[credentialId(tokenFile)];
      this.write(file);
    } catch {
      // Removing a credential is best effort; the token file remains untouched.
    }
  }

  private read(): CredentialFile {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<CredentialFile>;
      if (parsed.version === 1 && parsed.entries && typeof parsed.entries === "object") {
        return { version: 1, entries: { ...parsed.entries } };
      }
    } catch {
      // A missing or corrupt credential file is treated as an empty store.
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
