import { spawn } from "node:child_process";
import * as net from "node:net";

export interface Proc {
  pid: number;
  exited: Promise<number | null>;
  readonly stderr: string;
  stop(): Promise<void>;
}

export function spawnProc(
  bin: string,
  args: string[],
  opts: { env?: Record<string, string>; onErr?: (s: string) => void } = {}
): Proc {
  const child = spawn(bin, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    windowsHide: true,
  });
  let stderr = "";
  const collect = (d: Buffer): void => {
    const s = d.toString();
    stderr += s;
    if (stderr.length > 200000) stderr = stderr.slice(-100000);
    opts.onErr?.(s);
  };
  child.stderr?.on("data", collect);
  child.stdout?.on("data", collect);
  child.on("error", (e) => {
    stderr += `\nspawn error: ${e.message}`;
  });
  const exited = new Promise<number | null>((res) => child.on("exit", (code) => res(code)));
  return {
    pid: child.pid ?? -1,
    exited,
    get stderr() {
      return stderr;
    },
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      } else {
        child.kill("SIGTERM");
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* already gone */
          }
        }, 3000);
      }
      await Promise.race([exited, new Promise((r) => setTimeout(r, 6000))]);
    },
  };
}

export function portFree(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((res) => {
    const srv = net.createServer();
    srv.once("error", () => res(false));
    srv.once("listening", () => srv.close(() => res(true)));
    srv.listen(port, host);
  });
}

export function waitForPort(port: number, host = "127.0.0.1", timeoutMs = 20000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = (): void => {
      const s = net.connect({ port, host });
      s.once("connect", () => {
        s.destroy();
        resolve(true);
      });
      s.once("error", () => {
        s.destroy();
        if (Date.now() > deadline) resolve(false);
        else setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}
