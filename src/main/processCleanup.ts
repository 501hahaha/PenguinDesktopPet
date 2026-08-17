import { spawn, type ChildProcess } from "node:child_process";

const CHILD_EXIT_WAIT_MS = 3_000;
const terminationPromises = new WeakMap<ChildProcess, Promise<void>>();

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();

  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("close", finish);
      child.removeListener("error", finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    child.once("close", finish);
    child.once("error", finish);
  });
}

function runTaskkill(pid: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.once("close", () => resolve());
    killer.once("error", () => resolve());
  });
}

/** Terminate only a ChildProcess that this application created. */
export function terminateOwnedChildProcess(child: ChildProcess, label: string): Promise<void> {
  const existing = terminationPromises.get(child);
  if (existing) return existing;

  const termination = (async () => {
    const pid = child.pid;
    if (!pid || child.exitCode !== null || child.signalCode !== null) return;

    console.info(`[AppLifecycle] stopping ${label} pid=${pid}`);
    if (process.platform === "win32") {
      await runTaskkill(pid);
    } else if (!child.killed) {
      child.kill("SIGTERM");
    }
    await waitForChildExit(child, CHILD_EXIT_WAIT_MS);

    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // The process may have exited between the checks.
      }
      await waitForChildExit(child, CHILD_EXIT_WAIT_MS);
    }
    console.info(`[AppLifecycle] stopped ${label} pid=${pid}`);
  })().catch((error) => {
    console.warn(`[AppLifecycle] failed to stop ${label}:`, error);
  });

  terminationPromises.set(child, termination);
  return termination;
}
