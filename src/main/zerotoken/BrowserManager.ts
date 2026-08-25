import { BrowserWindow, session, type Session } from "electron";
import {
  getZeroTokenProvider,
  type ZeroTokenProviderDefinition,
  type ZeroTokenProviderId,
} from "./types";
import { logElectronSessionSource, logSessionSource } from "./SessionDiagnostics";

/** Owns the provider-specific login windows and never uses Electron's default session. */
export class BrowserManager {
  private readonly windows = new Map<ZeroTokenProviderId, BrowserWindow>();

  constructor(private readonly emitSessionDiagnostics = true) {}

  getPartition(provider: ZeroTokenProviderId): string {
    return getZeroTokenProvider(provider).partition;
  }

  getSession(provider: ZeroTokenProviderId): Session {
    return session.fromPartition(this.getPartition(provider));
  }

  createLoginWindow(provider: ZeroTokenProviderId): BrowserWindow {
    const definition = getZeroTokenProvider(provider);
    const existing = this.windows.get(provider);
    if (existing && !existing.isDestroyed()) {
      existing.show();
      existing.focus();
      return existing;
    }

    const loginWindow = new BrowserWindow({
      width: 1180,
      height: 820,
      minWidth: 860,
      minHeight: 640,
      title: `${definition.name} 登录`,
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        partition: definition.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    // Provider pages are untrusted remote content. Do not inject the desktop
    // pet preload or expose any IPC bridge to the login page.
    loginWindow.webContents.setWindowOpenHandler(() => ({ action: "allow" }));
    loginWindow.once("ready-to-show", () => {
      if (!loginWindow.isDestroyed()) loginWindow.show();
    });
    loginWindow.on("closed", () => {
      if (this.windows.get(provider) === loginWindow) this.windows.delete(provider);
    });
    if (this.emitSessionDiagnostics) loginWindow.webContents.on("did-finish-load", () => {
      void logSessionSource("ZeroToken Runtime Session", loginWindow, definition.partition).catch((error) => {
        console.warn("[ZeroToken Runtime Session] diagnostic failed", error);
      });
      void logElectronSessionSource("ZeroToken Default Session", session.defaultSession).catch((error) => {
        console.warn("[ZeroToken Default Session] diagnostic failed", error);
      });
    });

    this.windows.set(provider, loginWindow);
    void loginWindow.loadURL(definition.loginUrl).catch((error) => {
      console.warn(`[ZeroToken] failed to open ${definition.name} login page`, error);
    });
    return loginWindow;
  }

  getWindow(provider: ZeroTokenProviderId): BrowserWindow | null {
    const loginWindow = this.windows.get(provider);
    return loginWindow && !loginWindow.isDestroyed() ? loginWindow : null;
  }

  show(provider: ZeroTokenProviderId): void {
    const loginWindow = this.createLoginWindow(provider);
    loginWindow.show();
    loginWindow.focus();
  }

  hide(provider: ZeroTokenProviderId): void {
    this.getWindow(provider)?.hide();
  }

  close(provider: ZeroTokenProviderId): void {
    const loginWindow = this.getWindow(provider);
    if (!loginWindow) return;
    loginWindow.close();
    this.windows.delete(provider);
  }

  dispose(): void {
    for (const provider of this.windows.keys()) this.close(provider);
    this.windows.clear();
  }

  getDefinition(provider: ZeroTokenProviderId): ZeroTokenProviderDefinition {
    return getZeroTokenProvider(provider);
  }
}
