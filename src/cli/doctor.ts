import { existsSync } from "node:fs";
import { ensureWeldHome, paths } from "../util/paths.js";
import { loadConfig } from "../util/config.js";
import { getIdentity, machineName, shortFp } from "../core/identity.js";
import { loadPeers } from "../core/peers.js";
import { connectControl } from "../core/tunnel/client.js";
import { collectLocal } from "../core/telemetry.js";
import {
  binariesReady,
  installedBuild,
  listDevices,
  llamaServerPath,
  llamaVersion,
  PINNED_BUILD,
  rpcServerPath,
} from "../core/binaries.js";
import { portFree } from "../proc/supervisor.js";
import { banner, bullet, c, fail, fmtMB, kv, line, ok, rule, Spinner, warn } from "../ui.js";

export async function cmdDoctor(): Promise<void> {
  ensureWeldHome();
  const cfg = loadConfig();
  const id = getIdentity();
  banner("0.1.0", "doctor");

  let problems = 0;

  rule("identity");
  kv("machine", c.bold(machineName()));
  kv("node id", id.nodeId);
  kv("fingerprint", c.yellow(shortFp(id.fingerprint)));
  kv("weld home", paths.root);

  line();
  rule("binaries");
  if (binariesReady()) {
    ok(`llama-server + rpc-server present`);
    kv("llama-server", llamaServerPath());
    kv("rpc-server", rpcServerPath());
    const v = llamaVersion();
    if (v) ok(`runs: ${c.gray(v)}`);
    else {
      fail("llama-server did not execute");
      problems++;
    }
  } else {
    fail("binaries missing — run: weld setup");
    problems++;
  }
  const build = installedBuild();
  if (build === PINNED_BUILD) ok(`build ${build} matches pin`);
  else {
    fail(`build is ${build ?? "none"}, pin is ${PINNED_BUILD} — run weld setup`);
    problems++;
  }

  line();
  rule("devices");
  const devices = listDevices();
  if (devices.length) for (const d of devices) bullet(d);
  else warn("no accelerator devices reported (cpu only)");
  const tel = collectLocal();
  kv("ram free", `${fmtMB(tel.ramFreeMB)} / ${fmtMB(tel.ramTotalMB)}`);
  for (const g of tel.gpus) kv(g.name, `${fmtMB(g.vramFreeMB)} free / ${fmtMB(g.vramTotalMB)}`);

  line();
  rule("ports");
  for (const [label, port] of [
    ["control", cfg.controlPort],
    ["relay", cfg.relayPort],
    ["rpc", cfg.rpcPort],
    ["api", cfg.apiPort],
  ] as const) {
    const free = await portFree(port);
    if (free) ok(`${label} ${port} free`);
    else warn(`${label} ${port} in use (fine if weld node / llama-server is running)`);
  }

  line();
  rule("peers");
  const peers = loadPeers();
  if (peers.length === 0) warn("none paired — run: weld pair");
  for (const peer of peers) {
    const s = new Spinner(`${peer.name} (${peer.host})`);
    try {
      const conn = await connectControl(peer, 3000);
      const t0 = Date.now();
      await conn.request({ t: "ping", ts: t0 }, (m) => m.t === "pong", 3000);
      const rtt = Date.now() - t0;
      conn.close();
      s.succeed(
        `${c.bold(peer.name)} ${c.gray(peer.host)} — ${rtt}ms ${
          rtt < 2 ? c.green("(excellent)") : rtt < 10 ? c.green("(good)") : c.yellow("(high latency)")
        }`
      );
    } catch (e) {
      s.failed(
        `${c.bold(peer.name)} ${c.gray(peer.host)} — unreachable ${c.gray(
          "(is `weld node` running there?)"
        )}`
      );
      problems++;
    }
  }

  line();
  rule("models");
  if (!existsSync(paths.catalog)) warn("no models yet — weld models search <query>");
  else ok(`catalog at ${paths.catalog}`);

  line();
  if (problems === 0) ok("no problems found");
  else fail(`${problems} problem(s) found`);
  line();
}
