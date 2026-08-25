import type { BrowserWindow } from "electron";
import { BrowserManager } from "../BrowserManager";
import { ChatGPTSession, type ChatGPTConversation } from "../ChatGPTSession";
import { SessionManager } from "../SessionManager";
import {
  WebAIError,
  type WebAIAvailability,
  type WebAICompletion,
  type WebAICompletionOptions,
  type WebAIMessage,
  type WebAIProviderAdapter,
} from "../WebAIClient";
import { ResponseCollector, type ResponseSnapshot } from "../ResponseCollector";
import { ZeroTokenQueueError, ZeroTokenRequestQueue } from "../ZeroTokenRequestQueue";

const PROVIDER = "chatgpt-web" as const;
const DEFAULT_TIMEOUT_MS = 60_000;
const PAGE_READY_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;

interface PageState {
  hasComposer: boolean;
  isLoginPage: boolean;
  url: string;
}

interface SendState {
  assistantCount: number;
  assistantLast: string;
  diagnostics?: string;
}

/**
 * ChatGPT Web page automation. DOM selectors and browser handles stay here;
 * the Provider and Agent layers only see WebAI messages and typed errors.
 */
export class ChatGPTWebAdapter implements WebAIProviderAdapter {
  readonly provider = PROVIDER;

  constructor(
    private readonly browserManager = new BrowserManager(),
    private readonly sessionManager = new SessionManager(browserManager),
    private readonly chatGPTSession = new ChatGPTSession(browserManager, sessionManager),
    private readonly requestQueue = new ZeroTokenRequestQueue(),
  ) {}

  async checkAvailability(): Promise<WebAIAvailability> {
    return this.requestQueue.enqueue(
      () => this.checkAvailabilityInternal(),
      { timeoutMs: PAGE_READY_TIMEOUT_MS },
    ).promise.catch((error) => {
      const normalized = this.normalizeError(error);
      return {
        provider: PROVIDER,
        available: false,
        code: normalized.code,
        detail: normalized.message,
      };
    });
  }

  createConversation(): Promise<ChatGPTConversation> {
    return this.requestQueue.enqueue(
      (signal) => this.chatGPTSession.createConversation(signal),
      { timeoutMs: PAGE_READY_TIMEOUT_MS },
    ).promise.catch((error) => { throw this.normalizeError(error); });
  }

  continueConversation(): Promise<ChatGPTConversation> {
    return this.requestQueue.enqueue(
      (signal) => this.chatGPTSession.continueConversation(signal),
      { timeoutMs: PAGE_READY_TIMEOUT_MS },
    ).promise.catch((error) => { throw this.normalizeError(error); });
  }

  resetConversation(): Promise<ChatGPTConversation> {
    return this.requestQueue.enqueue(
      (signal) => this.chatGPTSession.resetConversation(signal),
      { timeoutMs: PAGE_READY_TIMEOUT_MS },
    ).promise.catch((error) => { throw this.normalizeError(error); });
  }

  async abortGeneration(): Promise<boolean> {
    const loginWindow = this.browserManager.getWindow(PROVIDER);
    let stopped = false;
    if (loginWindow && !loginWindow.isDestroyed()) {
      try {
        stopped = await loginWindow.webContents.executeJavaScript(`(() => {
          const visible = (element) => {
            if (!element) return false;
            const style = window.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
          };
          const buttons = Array.from(document.querySelectorAll("button, [role=button]"));
          const stop = buttons.find((button) => {
            if (!visible(button)) return false;
            if (button.matches('[data-testid="stop-button"], [data-testid*="stop" i]')) return true;
            const label = [button.getAttribute("aria-label"), button.getAttribute("title"), button.innerText, button.textContent]
              .filter(Boolean).join(" ").replace(/\\s+/g, " ").trim();
            return /^(stop(?: generating)?|停止生成)$/i.test(label);
          });
          if (!stop) return false;
          stop.click();
          return true;
        })()`, true) as boolean;
      } catch {
        stopped = false;
      }
    }
    return this.requestQueue.cancelActive() || stopped;
  }

  private async checkAvailabilityInternal(): Promise<WebAIAvailability> {
    try {
      const loggedIn = await this.sessionManager.checkLogin(PROVIDER);
      if (!loggedIn) {
        return {
          provider: PROVIDER,
          available: false,
          code: "LOGIN_REQUIRED",
          detail: "ChatGPT Web 尚未登录",
        };
      }

      const loginWindow = this.browserManager.getWindow(PROVIDER);
      if (loginWindow && !loginWindow.isDestroyed()) {
        const state = await this.readPageState(loginWindow);
        if (state.isLoginPage) {
          return {
            provider: PROVIDER,
            available: false,
            code: "SESSION_EXPIRED",
            detail: "ChatGPT Web Session 已失效，请重新登录",
          };
        }
      }

      return { provider: PROVIDER, available: true, detail: "ChatGPT Web Session 可用" };
    } catch (error) {
      const normalized = this.normalizeError(error);
      return {
        provider: PROVIDER,
        available: false,
        code: normalized.code,
        detail: normalized.message,
      };
    }
  }

  async chatCompletion(messages: WebAIMessage[], options?: WebAICompletionOptions): Promise<WebAICompletion> {
    return this.streamCompletion(messages, options);
  }

  async streamCompletion(messages: WebAIMessage[], options: WebAICompletionOptions = {}): Promise<WebAICompletion> {
    const handle = this.requestQueue.enqueue(
      (signal) => this.streamCompletionInternal(messages, { ...options, signal }),
      {
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        signal: options.signal,
      },
    );
    return handle.promise.catch((error) => { throw this.normalizeError(error); });
  }

  private async streamCompletionInternal(messages: WebAIMessage[], options: WebAICompletionOptions = {}): Promise<WebAICompletion> {
    try {
      this.assertMessages(messages);
      this.assertNotAborted(options.signal);

      const loggedIn = await this.sessionManager.checkLogin(PROVIDER);
      if (!loggedIn) throw new WebAIError("LOGIN_REQUIRED", "ChatGPT Web 尚未登录，请先完成网页登录");

      await this.chatGPTSession.continueConversation(options.signal);
      const loginWindow = this.browserManager.createLoginWindow(PROVIDER);
      this.browserManager.show(PROVIDER);
      await this.waitForComposer(loginWindow, options.signal);

      const prompt = this.toChatGPTPrompt(messages);
      const sendState = await this.sendPrompt(loginWindow, prompt, options.signal);
      return await this.waitForAssistant(loginWindow, sendState, options);
    } catch (error) {
      throw this.normalizeError(error);
    }
  }

  private async waitForComposer(window: BrowserWindow, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + PAGE_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      this.assertNotAborted(signal);
      try {
        const state = await this.readPageState(window);
        if (state.isLoginPage) throw new WebAIError("SESSION_EXPIRED", "ChatGPT Web 页面要求重新登录");
        if (state.hasComposer) {
          const response = await this.readResponseSnapshot(window);
          if (!response.hasStopGenerating) return;
        }
      } catch (error) {
        if (!(error instanceof WebAIError) || error.code !== "NETWORK_ERROR") throw error;
      }
      await this.delay(POLL_INTERVAL_MS, signal);
    }
    throw new WebAIError("MODEL_UNAVAILABLE", "未找到 ChatGPT Web 消息输入框");
  }

  private async readPageState(window: BrowserWindow): Promise<PageState> {
    if (window.isDestroyed()) throw new WebAIError("SESSION_EXPIRED", "ChatGPT Web 窗口已关闭");
    try {
      return await window.webContents.executeJavaScript(`(() => {
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
        return {
          hasComposer: Boolean(composer),
          isLoginPage: /\\/(auth|login)(\\/|\\?|$)/i.test(url),
          url,
        };
      })()`, true) as PageState;
    } catch (error) {
      throw new WebAIError("NETWORK_ERROR", this.errorMessage(error, "无法读取 ChatGPT Web 页面"), { cause: error });
    }
  }

  private async sendPrompt(window: BrowserWindow, prompt: string, signal?: AbortSignal): Promise<SendState> {
    this.assertNotAborted(signal);
    const serializedPrompt = JSON.stringify(prompt);
    try {
      const state = await window.webContents.executeJavaScript(`(async () => {
        const prompt = ${serializedPrompt};
        const visible = (element) => {
          if (!element) return false;
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        };
        const assistantTexts = () => {
          const nodes = [
            ...Array.from(document.querySelectorAll('[data-message-author-role="assistant"]')),
            ...Array.from(document.querySelectorAll('[data-testid*="conversation-turn"] .markdown, article[data-testid*="conversation-turn"] .prose, .markdown.prose')),
          ];
          const seen = new Set();
          return nodes
            .map((node) => (node.innerText || node.textContent || "").trim())
            .filter((text) => text && !seen.has(text) && seen.add(text));
        };
        const composer = [
          document.querySelector("#prompt-textarea"),
          document.querySelector("textarea[data-id='root']"),
          document.querySelector("textarea[data-testid='text-input']"),
          document.querySelector("textarea[data-testid='prompt-textarea']"),
          document.querySelector("textarea[placeholder]"),
          document.querySelector('[contenteditable="true"]'),
        ].find(visible);
        if (!composer) return { error: "composer" };

        composer.focus();
        if (composer.isContentEditable) {
          document.execCommand("selectAll", false);
          document.execCommand("insertText", false, prompt);
          if ((composer.innerText || "") !== prompt) composer.textContent = prompt;
          composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: prompt }));
        } else {
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
          if (setter) setter.call(composer, prompt);
          else composer.value = prompt;
          composer.dispatchEvent(new Event("input", { bubbles: true }));
          composer.dispatchEvent(new Event("change", { bubbles: true }));
        }

        // React may render or enable the send control one tick after the
        // input event. Give the page a short chance to commit that state
        // before resolving selectors.
        await new Promise((resolve) => setTimeout(resolve, 120));

        const before = assistantTexts();
        const legacySendButton = [
          document.querySelector('button[data-testid="send-button"]'),
          document.querySelector('button[aria-label*="Send"]'),
          document.querySelector('button[aria-label*="发送"]'),
        ].find((button) => visible(button) && !button.disabled);
        const buttonLabel = (button) => [
          button.getAttribute("aria-label"),
          button.getAttribute("title"),
          button.innerText,
          button.textContent,
        ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
        const composerForm = composer.closest("form");
        const nearbyButtons = [
          composerForm,
          composer.parentElement,
          composer.parentElement?.parentElement,
          composer.parentElement?.parentElement?.parentElement,
        ].flatMap((parent) => parent ? Array.from(parent.querySelectorAll("button")) : []);
        const candidates = [
          legacySendButton,
          document.querySelector('button[data-testid="send-button"]'),
          document.querySelector('button[data-testid*="send" i]'),
          document.querySelector('button[aria-label*="send" i]'),
          document.querySelector('button[aria-label*="发送"]'),
          document.querySelector('button[title*="send" i]'),
          document.querySelector('[role="button"][aria-label*="send" i]'),
          document.querySelector('[role="button"][aria-label*="发送"]'),
          ...nearbyButtons,
          ...Array.from(document.querySelectorAll('[role="button"]')),
        ];
        const sendButton = candidates.find((button) => {
          if (!visible(button) || button.disabled) return false;
          if (button.matches('[data-testid="send-button"], [data-testid*="send" i]')) return true;
          return /\b(send|submit|ask|go)\b|发送|提交/i.test(buttonLabel(button));
        });
        if (sendButton) {
          sendButton.click();
        } else {
          // The composer can be submitted with Enter even when the visual
          // button is rendered as a non-button element or is temporarily
          // omitted during a React transition.
          composer.dispatchEvent(new KeyboardEvent("keydown", {
            key: "Enter",
            code: "Enter",
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true,
          }));
          composer.dispatchEvent(new KeyboardEvent("keyup", {
            key: "Enter",
            code: "Enter",
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true,
          }));
          await new Promise((resolve) => setTimeout(resolve, 120));
          const composerValue = composer.isContentEditable
            ? (composer.innerText || "").trim()
            : String(composer.value || "").trim();
          if (composerValue) {
            const controls = Array.from(document.querySelectorAll("button, [role=button]"))
              .filter(visible)
              .slice(0, 30)
              .map((button) => ({
                tag: button.tagName.toLowerCase(),
                testId: button.getAttribute("data-testid") || "",
                aria: button.getAttribute("aria-label") || "",
                title: button.getAttribute("title") || "",
                text: (button.innerText || button.textContent || "").trim().slice(0, 80),
                disabled: Boolean(button.disabled),
              }));
            return { error: "send-button", diagnostics: JSON.stringify(controls) };
          }
        }
        return { assistantCount: before.length, assistantLast: before[before.length - 1] || "" };
      })()`, true) as SendState & { error?: string };

      if (state.error === "composer") throw new WebAIError("MODEL_UNAVAILABLE", "未找到 ChatGPT Web 消息输入框");
      if (state.error === "send-button") {
        const detail = state.diagnostics ? ` (${state.diagnostics.slice(0, 1200)})` : "";
        throw new WebAIError("MODEL_UNAVAILABLE", `ChatGPT Web send control was unavailable${detail}`);
      }
      return state;
    } catch (error) {
      if (error instanceof WebAIError) throw error;
      throw new WebAIError("NETWORK_ERROR", this.errorMessage(error, "ChatGPT Web 消息发送失败"), { cause: error });
    }
  }

  private async waitForAssistant(
    window: BrowserWindow,
    baseline: SendState,
    options: WebAICompletionOptions,
  ): Promise<WebAICompletion> {
    const collector = new ResponseCollector();
    const result = await collector.collect({
      read: async () => {
        if (window.isDestroyed()) throw new WebAIError("SESSION_EXPIRED", "ChatGPT Web window was closed");
        if (!(await this.sessionManager.checkLogin(PROVIDER))) {
          throw new WebAIError("SESSION_EXPIRED", "ChatGPT Web Session expired; login is required");
        }
        return this.readResponseSnapshot(window);
      },
      baseline,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      signal: options.signal,
      onDelta: options.onDelta,
    });
    return { role: "assistant", content: result.content };
  }

  private async readResponseSnapshot(window: BrowserWindow): Promise<ResponseSnapshot> {
    try {
      return await window.webContents.executeJavaScript(`(() => {
        const visible = (element) => {
          if (!element) return false;
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        };
        const nodes = [
          ...Array.from(document.querySelectorAll('[data-message-author-role="assistant"]')),
          ...Array.from(document.querySelectorAll('[data-testid*="conversation-turn"] .markdown, article[data-testid*="conversation-turn"] .prose, .markdown.prose')),
        ];
        const texts = nodes
          .map((node) => (node.innerText || node.textContent || "").trim())
          .filter(Boolean);
        const hasStopGenerating = Array.from(document.querySelectorAll("button, [role=button]" )).some((button) => {
          if (!visible(button)) return false;
          if (button.matches('[data-testid="stop-button"], [data-testid*="stop" i]')) return true;
          const label = [button.getAttribute("aria-label"), button.getAttribute("title"), button.innerText, button.textContent]
            .filter(Boolean)
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
          return /^(stop(?: generating)?|停止生成)$/i.test(label);
        });
        return { texts, hasStopGenerating };
      })()`, true) as ResponseSnapshot;
    } catch (error) {
      throw new WebAIError("NETWORK_ERROR", this.errorMessage(error, "Unable to read ChatGPT Web response"), { cause: error });
    }
  }

  private toChatGPTPrompt(messages: WebAIMessage[]): string {
    return messages
      .map((message) => {
        const label = message.role === "system" ? "System" : message.role === "assistant" ? "Assistant" : "User";
        return `${label}:\n${message.content.trim()}`;
      })
      .join("\n\n")
      .trim();
  }

  private assertMessages(messages: WebAIMessage[]): void {
    if (!messages.length || messages.some((message) => !message.content.trim())) {
      throw new WebAIError("MODEL_UNAVAILABLE", "消息内容不能为空");
    }
  }

  private assertNotAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new WebAIError("NETWORK_ERROR", "ChatGPT Web 请求已取消");
  }

  private async delay(ms: number, signal?: AbortSignal): Promise<void> {
    this.assertNotAborted(signal);
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
    this.assertNotAborted(signal);
  }

  private normalizeError(error: unknown): WebAIError {
    if (error instanceof WebAIError) return error;
    if (error instanceof ZeroTokenQueueError) {
      return new WebAIError("NETWORK_ERROR", error.message, { cause: error });
    }
    return new WebAIError("NETWORK_ERROR", this.errorMessage(error, "ChatGPT Web 请求失败"), { cause: error });
  }

  private errorMessage(error: unknown, fallback: string): string {
    return error instanceof Error && error.message ? error.message : fallback;
  }
}
