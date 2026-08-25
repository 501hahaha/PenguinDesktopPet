import { app, type ClearStorageDataOptions } from "electron";
import { BrowserManager } from "./BrowserManager";
import { getZeroTokenProvider, type ZeroTokenProviderId } from "./types";

const SESSION_COOKIE_NAMES: Record<ZeroTokenProviderId, readonly string[]> = {
  "chatgpt-web": [
    "__Secure-next-auth.session-token",
    "__Secure-next-auth.session-token.0",
    "__Secure-next-auth.session-token.1",
    "next-auth.session-token",
  ],
  "claude-web": ["sessionKey"],
  "gemini-web": ["SID", "__Secure-1PSID", "__Secure-3PSID"],
};

type SessionCookie = {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expirationDate?: number;
  httpOnly?: boolean;
  secure?: boolean;
};

type PageLoginState = "logged_in" | "logged_out" | "unknown";

type PageLoginProbe = {
  state: PageLoginState;
  hasComposer: boolean;
  hasAccountControl: boolean;
  hasLoginControl: boolean;
  hasChallengeText: boolean;
  hasLoggedOutText: boolean;
  urlPath: string;
  readyState: string;
};

const CHATGPT_COOKIE_DOMAINS = ["chatgpt.com", "openai.com"];
const NON_AUTH_COOKIE_NAMES = new Set([
  "__cf_bm",
  "_cfuvid",
  "cf_clearance",
  "__cflb",
  "_abck",
  "bm_sz",
  "ak_bmsc",
  "datadome",
  "__secure-next-auth.csrf-token",
  "next-auth.csrf-token",
  "__secure-next-auth.callback-url",
  "next-auth.callback-url",
]);

function isActiveCookie(cookie: SessionCookie): boolean {
  return cookie.expirationDate === undefined || cookie.expirationDate > Date.now() / 1000;
}

function isChatGptCookie(cookie: SessionCookie): boolean {
  const domain = (cookie.domain ?? "").replace(/^\.+/, "").toLowerCase();
  return CHATGPT_COOKIE_DOMAINS.some((allowed) => domain === allowed || domain.endsWith(`.${allowed}`));
}

function hasSessionCookie(provider: ZeroTokenProviderId, cookies: SessionCookie[]): boolean {
  const names = new Set(SESSION_COOKIE_NAMES[provider]);
  return cookies.some((cookie) => {
    if (!isActiveCookie(cookie)) return false;
    if (names.has(cookie.name)) return true;
    if (provider === "claude-web") {
      return cookie.value.startsWith("sk-ant-sid01-") || cookie.value.startsWith("sk-ant-sid02-");
    }
    if (provider !== "chatgpt-web" || !isChatGptCookie(cookie)) return false;

    // ChatGPT has changed its web-session cookie names over time. Keep the
    // known next-auth names above, but also accept an active same-site,
    // secure/httpOnly cookie unless it is clearly a CSRF, callback, or CDN
    // infrastructure cookie. The page probe below remains authoritative when
    // a browser window is available.
    const normalizedName = cookie.name.toLowerCase();
    if (NON_AUTH_COOKIE_NAMES.has(normalizedName)) return false;
    if (normalizedName.includes("csrf") || normalizedName.includes("callback")) return false;
    return cookie.httpOnly === true || cookie.secure === true;
  });
}

function dedupeCookies(cookies: SessionCookie[]): SessionCookie[] {
  const unique = new Map<string, SessionCookie>();
  for (const cookie of cookies) {
    const key = `${cookie.name}\u0000${cookie.domain ?? ""}\u0000${cookie.path ?? "/"}`;
    unique.set(key, cookie);
  }
  return [...unique.values()];
}

function safeCookieDiagnostics(cookies: SessionCookie[]): Array<Record<string, unknown>> {
  return cookies.map((cookie) => ({
    name: cookie.name,
    domain: cookie.domain ?? "",
    path: cookie.path ?? "/",
    expiration: cookie.expirationDate ?? null,
    httpOnly: cookie.httpOnly === true,
  }));
}

function unknownPageProbe(): PageLoginProbe {
  return {
    state: "unknown",
    hasComposer: false,
    hasAccountControl: false,
    hasLoginControl: false,
    hasChallengeText: false,
    hasLoggedOutText: false,
    urlPath: "",
    readyState: "unknown",
  };
}

/** Reads and clears Electron's persisted partition; it never serializes cookies itself. */
export class SessionManager {
  constructor(private readonly browserManager: BrowserManager) {}

  async checkLogin(provider: ZeroTokenProviderId): Promise<boolean> {
    const session = this.browserManager.getSession(provider);
    // Query the complete persisted partition instead of filtering on one URL
    // or assuming a single cookie name. Electron applies cookie domain rules
    // for us and this also covers cookies set on auth.openai.com.
    const cookies = dedupeCookies((await session.cookies.get({})) as SessionCookie[]);
    const cookieLogin = hasSessionCookie(provider, cookies);
    const pageProbe = provider === "chatgpt-web" ? await this.probeChatGptPage() : null;

    // A logged-out page wins over stale cookies; a logged-in page is enough to
    // establish the current browser session even when the site no longer uses
    // the historical next-auth cookie names. Only fall back to cookies when
    // the page cannot be inspected.
    const loggedIn =
      provider === "chatgpt-web" && pageProbe
        ? pageProbe.state === "logged_in" || (pageProbe.state === "unknown" && cookieLogin)
        : cookieLogin;

    if (!app.isPackaged) {
      console.info("[ZeroToken] Login Diagnose:");
      console.info(
        JSON.stringify(
          {
            provider,
            cookies: safeCookieDiagnostics(cookies),
            page: pageProbe?.state ?? "unknown",
            pageSignals: pageProbe
              ? {
                  composer: pageProbe.hasComposer,
                  account: pageProbe.hasAccountControl,
                  loginControl: pageProbe.hasLoginControl,
                  loggedOutText: pageProbe.hasLoggedOutText,
                  challengeText: pageProbe.hasChallengeText,
                }
              : null,
            pageUrl: pageProbe?.urlPath ?? "",
            pageReadyState: pageProbe?.readyState ?? "unknown",
            result: loggedIn,
          },
          null,
          2,
        ),
      );
    }

    return loggedIn;
  }

  private async probeChatGptPage(): Promise<PageLoginProbe | null> {
    const loginWindow = this.browserManager.getWindow("chatgpt-web");
    if (!loginWindow || loginWindow.isDestroyed()) return null;

    try {
      const result = await loginWindow.webContents.executeJavaScript(
        `(() => {
          const visible = (element) => {
            if (!element) return false;
            const style = window.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden" &&
              rect.width > 0 && rect.height > 0;
          };
          const label = (element) => (element?.getAttribute("aria-label") || "") + " " +
            (element?.getAttribute("data-testid") || "") + " " +
            (element?.textContent || "");
          const controls = Array.from(document.querySelectorAll("button, a, [role=button]"));
          const hasLoginControl = controls.some((element) =>
            visible(element) && /\\b(log[ -]?in|sign[ -]?in|sign[ -]?up)\\b|登录|注册/i.test(label(element))
          );
          const bodyText = (document.body?.innerText || "").slice(0, 20000);
          const hasLoggedOutText = /\\b(log[ -]?in|sign[ -]?in|sign[ -]?up)\\b|登录|注册/i.test(bodyText);
          const hasChallengeText = /checking your browser|verify you are human|enable cookies|access denied|network error|something went wrong/i.test(bodyText);
          const hasComposer = [
            "#prompt-textarea",
            "textarea[data-id='root']",
            "textarea[placeholder]",
            "[contenteditable='true']",
            "[data-testid='text-input']",
            "[data-testid='prompt-textarea']",
          ].some((selector) => {
            try { return Array.from(document.querySelectorAll(selector)).some(visible); }
            catch { return false; }
          });
          const hasAccountControl = [
            "[data-testid*='profile']",
            "[data-testid='profile-button']",
            "[data-testid='accounts-menu-button']",
            "[aria-label*='Account']",
            "[aria-label*='account']",
            "[aria-label*='Profile']",
            "[aria-label*='profile']",
          ].some((selector) => {
            try { return Array.from(document.querySelectorAll(selector)).some(visible); }
            catch { return false; }
          });
          const url = window.location.href;
          const urlPath = (() => {
            try { return new URL(url).origin + new URL(url).pathname; }
            catch { return ""; }
          })();
          const loginUrl = /(?:auth|login|sign-in|log-in)/i.test(urlPath);
          const state = loginUrl || (hasLoginControl && !hasComposer && !hasAccountControl)
            ? "logged_out"
            : hasLoggedOutText && !hasComposer && !hasAccountControl
              ? "logged_out"
            : hasComposer || hasAccountControl
              ? "logged_in"
              : "unknown";
          return { state, hasComposer, hasAccountControl, hasLoginControl, hasLoggedOutText, hasChallengeText, urlPath, readyState: document.readyState };
        })()`,
        true,
      );

      if (!result || typeof result !== "object") {
        return unknownPageProbe();
      }
      const state = result as Partial<PageLoginProbe>;
      return {
        state: state.state === "logged_in" || state.state === "logged_out" ? state.state : "unknown",
        hasComposer: state.hasComposer === true,
        hasAccountControl: state.hasAccountControl === true,
        hasLoginControl: state.hasLoginControl === true,
        hasChallengeText: state.hasChallengeText === true,
        hasLoggedOutText: state.hasLoggedOutText === true,
        urlPath: typeof state.urlPath === "string" ? state.urlPath : "",
        readyState: typeof state.readyState === "string" ? state.readyState : "unknown",
      };
    } catch {
      return unknownPageProbe();
    }
  }

  async logout(provider: ZeroTokenProviderId): Promise<void> {
    await this.clearSession(provider);
  }

  async clearSession(provider: ZeroTokenProviderId): Promise<void> {
    const storage: ClearStorageDataOptions["storages"] = [
      "cookies",
      "localstorage",
      "indexdb",
      "serviceworkers",
      "cachestorage",
      "websql",
      "shadercache",
    ];
    await this.browserManager.getSession(provider).clearStorageData({ storages: storage });
  }

  getPartition(provider: ZeroTokenProviderId): string {
    return getZeroTokenProvider(provider).partition;
  }
}
