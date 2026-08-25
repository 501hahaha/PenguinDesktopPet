import { app, session, type BrowserWindow, type Session } from "electron";

export interface SessionCookieDiagnostic {
  name: string;
  domain: string;
  path: string;
  expiration: number | null;
  httpOnly: boolean;
}

export interface SessionSourceDiagnostic {
  label: string;
  userData: string;
  partition: string;
  expectedPartition: string | null;
  sessionIdentityMatchesExpected: boolean | null;
  persistent: boolean;
  storagePath: string | null;
  cookieCount: number;
  cookies: SessionCookieDiagnostic[];
}

/**
 * Reads only non-sensitive Session metadata from the BrowserWindow that owns
 * the web login. Cookie values, tokens, and authorization headers are never
 * returned or logged.
 */
export async function readSessionSource(
  label: string,
  loginWindow: BrowserWindow,
  expectedPartition?: string,
): Promise<SessionSourceDiagnostic> {
  return readElectronSessionSource(label, loginWindow.webContents.session, expectedPartition);
}

export async function readElectronSessionSource(
  label: string,
  electronSession: Session,
  expectedPartition?: string,
): Promise<SessionSourceDiagnostic> {
  const cookies = await electronSession.cookies.get({});
  const expectedSession = expectedPartition ? session.fromPartition(expectedPartition) : null;
  return {
    label,
    userData: app.getPath("userData"),
    // Electron's Session object does not expose a runtime `partition`
    // property. The identity and storage path below are authoritative.
    partition: "<not exposed by Electron Session API>",
    expectedPartition: expectedPartition ?? null,
    sessionIdentityMatchesExpected: expectedSession ? expectedSession === electronSession : null,
    persistent: electronSession.isPersistent(),
    storagePath: electronSession.storagePath,
    cookieCount: cookies.length,
    cookies: cookies.map((cookie) => ({
      name: cookie.name,
      domain: cookie.domain ?? "",
      path: cookie.path ?? "/",
      expiration: cookie.expirationDate ?? null,
      httpOnly: cookie.httpOnly === true,
    })),
  };
}

export function formatSessionSource(
  diagnostic: SessionSourceDiagnostic,
  expectedPartition?: string,
): string {
  const cookieLines = diagnostic.cookies.length === 0
    ? "  <none>"
    : diagnostic.cookies
      .map((cookie) =>
        `  - ${cookie.name} domain=${cookie.domain} path=${cookie.path} expiration=${cookie.expiration ?? "session"} httpOnly=${cookie.httpOnly}`,
      )
      .join("\n");
  const partitionMatch = expectedPartition === undefined
    ? ""
    : `\npartitionMatchesExpected: ${diagnostic.sessionIdentityMatchesExpected === true}`;
  return [
    `[${diagnostic.label}]`,
    `userData: ${diagnostic.userData}`,
    `BrowserWindow.webContents.session.partition: ${diagnostic.partition}`,
    `expectedPartition: ${diagnostic.expectedPartition ?? "<not provided>"}`,
    `sessionIdentityMatchesExpected: ${diagnostic.sessionIdentityMatchesExpected ?? "unknown"}`,
    `persistent: ${diagnostic.persistent}`,
    `storagePath: ${diagnostic.storagePath ?? "<none>"}`,
    `cookies: ${diagnostic.cookieCount}`,
    `cookieNames:`,
    cookieLines,
    partitionMatch.trimStart(),
  ].filter(Boolean).join("\n");
}

export async function logSessionSource(
  label: string,
  loginWindow: BrowserWindow,
  expectedPartition?: string,
): Promise<SessionSourceDiagnostic> {
  const diagnostic = await readSessionSource(label, loginWindow, expectedPartition);
  console.info(formatSessionSource(diagnostic, expectedPartition));
  return diagnostic;
}

export async function logElectronSessionSource(
  label: string,
  electronSession: Session,
  expectedPartition?: string,
): Promise<SessionSourceDiagnostic> {
  const diagnostic = await readElectronSessionSource(label, electronSession, expectedPartition);
  console.info(formatSessionSource(diagnostic, expectedPartition));
  return diagnostic;
}
