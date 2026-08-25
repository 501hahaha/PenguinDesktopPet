import type { BrowserWindow } from "electron";
import { BrowserManager } from "./BrowserManager";
import { SessionManager } from "./SessionManager";
import { WebAIError } from "./WebAIClient";

const PROVIDER = "chatgpt-web" as const;
const CHATGPT_URL = "https://chatgpt.com/";
const READY_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;

export interface ChatGPTConversation {
  id: string | null;
  url: string;
  createdAt: number;
}

/** Owns the current ChatGPT Web conversation without exposing BrowserWindow to Agents. */
export class ChatGPTSession {
  private currentConversation: ChatGPTConversation | null = null;

  constructor(
    private readonly browserManager = new BrowserManager(),
    private readonly sessionManager = new SessionManager(browserManager),
  ) {}

  async createConversation(signal?: AbortSignal): Promise<ChatGPTConversation> {
    await this.assertLoggedIn(signal);
    const loginWindow = this.ensureWindow();
    this.assertNotAborted(signal);
    let clicked = false;
    try {
      clicked = await loginWindow.webContents.executeJavaScript(`(() => {
        const visible = (element) => {
          if (!element) return false;
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        };
        const candidates = [
          document.querySelector('[data-testid="new-chat-button"]'),
          document.querySelector('a[href="/"]'),
          ...Array.from(document.querySelectorAll("button, a, [role=button]")),
        ];
        const target = candidates.find((element) => {
          if (!visible(element)) return false;
          const label = [element.getAttribute("aria-label"), element.getAttribute("data-testid"), element.innerText, element.textContent]
            .filter(Boolean).join(" ").replace(/\\s+/g, " ").trim();
          return element.matches('[data-testid="new-chat-button"]') || /^(new chat|new conversation|新聊天|新对话)$/i.test(label);
        });
        if (!target) return false;
        target.click();
        return true;
      })()`, true) as boolean;
    } catch (error) {
      throw new WebAIError("NETWORK_ERROR", this.errorMessage(error, "无法创建 ChatGPT Web 会话"), { cause: error });
    }
    if (!clicked) {
      try {
        await loginWindow.loadURL(CHATGPT_URL);
      } catch (error) {
        throw new WebAIError("NETWORK_ERROR", this.errorMessage(error, "ChatGPT Web 新会话页面加载失败"), { cause: error });
      }
    }
    await this.waitForComposer(loginWindow, signal);
    this.currentConversation = this.captureConversation(loginWindow);
    return { ...this.currentConversation };
  }

  async continueConversation(signal?: AbortSignal): Promise<ChatGPTConversation> {
    await this.assertLoggedIn(signal);
    const loginWindow = this.ensureWindow();
    this.assertNotAborted(signal);
    const currentPage = this.captureConversation(loginWindow);
    if (!this.currentConversation || !this.currentConversation.id) {
      this.currentConversation = currentPage;
      return { ...currentPage };
    }
    if (currentPage.id === this.currentConversation.id) return { ...this.currentConversation };

    try {
      await loginWindow.loadURL(this.currentConversation.url);
    } catch (error) {
      throw new WebAIError("NETWORK_ERROR", this.errorMessage(error, "ChatGPT Web 会话恢复失败"), { cause: error });
    }
    await this.waitForComposer(loginWindow, signal);
    return { ...this.currentConversation };
  }

  async resetConversation(signal?: AbortSignal): Promise<ChatGPTConversation> {
    this.currentConversation = null;
    return this.createConversation(signal);
  }

  getCurrentConversation(): ChatGPTConversation | null {
    return this.currentConversation ? { ...this.currentConversation } : null;
  }

  private ensureWindow(): BrowserWindow {
    const loginWindow = this.browserManager.createLoginWindow(PROVIDER);
    this.browserManager.show(PROVIDER);
    return loginWindow;
  }

  private async assertLoggedIn(signal?: AbortSignal): Promise<void> {
    this.assertNotAborted(signal);
    if (!(await this.sessionManager.checkLogin(PROVIDER))) {
      throw new WebAIError("LOGIN_REQUIRED", "ChatGPT Web 尚未登录，请先完成网页登录");
    }
  }

  private async waitForComposer(window: BrowserWindow, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      this.assertNotAborted(signal);
      if (window.isDestroyed()) throw new WebAIError("SESSION_EXPIRED", "ChatGPT Web 窗口已关闭");
      try {
        const state = await window.webContents.executeJavaScript(`(() => {
          const visible = (element) => {
            if (!element) return false;
            const style = window.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
          };
          const composer = [
            document.querySelector("#prompt-textarea"),
            document.querySelector("textarea[data-id='root']"),
            document.querySelector("textarea[data-testid='text-input']"),
            document.querySelector("textarea[data-testid='prompt-textarea']"),
            document.querySelector("textarea[placeholder]"),
            document.querySelector('[contenteditable="true"]'),
          ].find(visible);
          const url = window.location.href;
          return { hasComposer: Boolean(composer), login: /\\/(auth|login)(\\/|\\?|$)/i.test(url) };
        })()`, true) as { hasComposer?: boolean; login?: boolean };
        if (state.login) throw new WebAIError("SESSION_EXPIRED", "ChatGPT Web 页面要求重新登录");
        if (state.hasComposer) return;
      } catch (error) {
        if (error instanceof WebAIError) throw error;
      }
      await this.delay(POLL_INTERVAL_MS, signal);
    }
    throw new WebAIError("MODEL_UNAVAILABLE", "未找到 ChatGPT Web 消息输入框");
  }

  private captureConversation(window: BrowserWindow): ChatGPTConversation {
    const url = window.webContents.getURL() || CHATGPT_URL;
    const match = url.match(/\/c\/([^/?#]+)/i);
    return {
      id: match?.[1] ?? null,
      url,
      createdAt: this.currentConversation?.createdAt ?? Date.now(),
    };
  }

  private assertNotAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new WebAIError("NETWORK_ERROR", "ChatGPT Web 会话操作已取消");
  }

  private async delay(ms: number, signal?: AbortSignal): Promise<void> {
    this.assertNotAborted(signal);
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
    this.assertNotAborted(signal);
  }

  private errorMessage(error: unknown, fallback: string): string {
    return error instanceof Error && error.message ? error.message : fallback;
  }
}
