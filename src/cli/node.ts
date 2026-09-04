import { mkdirSync } from "node:fs";
import { ensureWeldHome, paths } from "../util/paths.js";
import { loadConfig } from "../util/config.js";
import { getIdentity, shortFp } from "../core/identity.js";
import { loadPeers } from "../core/peers.js";
import { collectLocal } from "../core/telemetry.js";
import { ControlServer, startRelay } from "../core/tunnel/server.js";
import { binariesReady, rpcServerPath } from "../core/binaries.js";
import { Proc, spawnProc, waitForPort } from "../proc/supervisor.js";
import {
  banner,
  box,
  bullet,
  c,
  fail,
  fmtMB,
  info,
  kv,
  line,
  ok,
  rule,
  step,
  warn,
} from "../ui.js";
import { lanIps } from "./pair.js";

export async function cmdNode(): Promise<void> {
  ensureWeldHome();
  const cfg = loadConfig();
  const id = getIdentity();
  banner("0.1.0", "donor node");

  if (!binariesReady()) {
    fail("llama.cpp binaries missing — run: weld setup");
    line();
    process.exitCode = 1;
    return;
  }
  const peers = loadPeers();
  if (peers.length === 0) {
    warn("no paired peers yet — run: weld pair");
    line();
  }

  let rpc: Proc | null = null;
  let sessions = 0;

  const server = new ControlServer(
    {
      onPeerHello: (name) => info(`${c.bold(name)} connected`),
      onJoin: async (_sessionId, peerName) => {
        sessions++;
        if (rpc) {
          step(`${c.bold(peerName)} joined the running session`);
          return;
        }
        mkdirSync(paths.rpcCache, { recursive: true });
        rule("session");
        step(`${c.bold(peerName)} is starting a cluster — launching rpc-server`);
        rpc = spawnProc(
          rpcServerPath(),
          ["--host", "127.0.0.1", "--port", String(cfg.rpcPort), "-c"],
          { env: { LLAMA_CACHE: paths.rpcCache } }
        );
        const up = await waitForPort(cfg.rpcPort, "127.0.0.1", 20000);
        if (!up) {
          const detail = rpc.stderr.trim().split("\n").slice(-3).join(" | ");
          await rpc.stop();
          rpc = null;
          sessions = Math.max(0, sessions - 1);
          throw new Error(`rpc-server did not start: ${detail || "no output"}`);
        }
        ok(`rpc-server listening on 127.0.0.1:${cfg.rpcPort} (cache on)`);
      },
      onSessionEnd: (peerName) => {
        sessions = Math.max(0, sessions - 1);
        if (sessions > 0) return;
        if (rpc) {
          const proc: Proc = rpc;
          rpc = null;
          void proc.stop().then(() => {
            info(`session with ${c.bold(peerName)} ended — rpc-server stopped`);
          });
        }
      },
      telemetry: async () => ({ t: "telemetry", ...collectLocal(rpc !== null) }),
    },
    cfg.rpcPort
  );

  try {
    await server.listen(cfg.controlPort);
    await startRelay(cfg.relayPort, cfg.rpcPort);
  } catch (e) {
    fail(`cannot bind ports: ${e instanceof Error ? e.message : String(e)}`);
    bullet("another weld node may already be running (or the port is taken)");
    line();
    process.exitCode = 1;
    return;
  }

  const tel = collectLocal(false);
  box(
    [
      `${c.gray("machine")}   ${c.bold(tel.name)} ${c.gray("(" + shortFp(id.fingerprint).slice(0, 11) + ")")}`,
      `${c.gray("devices")}   ${
        tel.gpus.length ? tel.gpus.map((g) => `${g.name} ${fmtMB(g.vramFreeMB)} free`).join(", ") : "cpu only"
      }`,
      `${c.gray("ram free")}  ${fmtMB(tel.ramFreeMB)} / ${fmtMB(tel.ramTotalMB)}`,
      `${c.gray("listening")} control :${cfg.controlPort}  relay :${cfg.relayPort}`,
      `${c.gray("ips")}       ${lanIps().join(", ") || "none detected"}`,
    ],
    "donating to paired heads"
  );
  line();
  kv("peers", String(peers.length));
  info("waiting for a head to start a session — ctrl+c to stop");
  line();

  const telemetryTimer = setInterval(
    () => server.broadcast({ t: "telemetry", ...collectLocal(rpc !== null) }),
    2000
  );

  const shutdown = (): void => {
    clearInterval(telemetryTimer);
    void (async () => {
      line();
      if (rpc) {
        const proc: Proc = rpc;
        rpc = null;
        await proc.stop();
      }
      server.close();
      ok("node stopped");
      line();
      process.exit(0);
    })();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await new Promise<void>(() => {});
}
