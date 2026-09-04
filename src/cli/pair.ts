import * as tls from "node:tls";
import { networkInterfaces } from "node:os";
import { ensureWeldHome } from "../util/paths.js";
import { loadConfig } from "../util/config.js";
import { getIdentity, machineName, shortFp } from "../core/identity.js";
import { addPeer, loadPeers, peerFromCert } from "../core/peers.js";
import { JsonLines, Msg } from "../core/proto.js";
import {
  banner,
  box,
  bullet,
  c,
  confirm,
  fail,
  info,
  kv,
  line,
  ok,
  rule,
  Spinner,
  step,
  warn,
} from "../ui.js";

export function lanIps(): string[] {
  const ips: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list ?? []) {
      if (String(i.family) === "IPv4" && !i.internal) ips.push(i.address);
    }
  }
  return ips;
}

export async function cmdPair(
  code?: string,
  opts?: { host?: string; port?: string }
): Promise<void> {
  ensureWeldHome();
  const cfg = loadConfig();
  if (code && opts?.host) {
    await dial(code, opts.host, parseInt(opts.port || "7100", 10));
    return;
  }
  if (code) {
    banner("0.1.0", "pair");
    fail("missing --host");
    bullet(`weld pair ${code} --host <ip-of-the-other-machine> --port ${cfg.controlPort}`);
    line();
    process.exitCode = 1;
    return;
  }
  await listen(cfg.controlPort);
}

async function dial(code: string, host: string, port: number): Promise<void> {
  const id = getIdentity();
  const cfg = loadConfig();
  banner("0.1.0", `pairing with ${host}:${port}`);
  const s = new Spinner(`connecting to ${host}:${port}`);
  let handler: (m: Msg) => void = () => {};
  const sock = tls.connect({ host, port, rejectUnauthorized: false });
  sock.setEncoding("utf8");
  const jl = new JsonLines((d) => sock.write(d), (m) => handler(m));
  sock.on("data", (d: string) => jl.feed(d));
  sock.on("error", () => {});
  try {
    await new Promise<void>((res, rej) => {
      sock.once("secureConnect", () => res());
      sock.once("error", rej);
      setTimeout(() => rej(new Error("connection timed out — wrong ip/port, or firewall")), 8000);
    });
  } catch (e) {
    s.failed(e instanceof Error ? e.message : String(e));
    line();
    process.exitCode = 1;
    return;
  }
  s.succeed("connected");

  jl.send({
    t: "pairRequest",
    code,
    name: machineName(),
    certPem: id.certPem,
    controlPort: cfg.controlPort,
    relayPort: cfg.relayPort,
  });

  const waiting = new Spinner("waiting for the other machine to accept");
  let answer: Msg;
  try {
    answer = await new Promise<Msg>((res, rej) => {
      const timer = setTimeout(() => rej(new Error("timed out — was the code correct?")), 180000);
      handler = (m) => {
        if (m.t === "pairAccept" || m.t === "pairDeny") {
          clearTimeout(timer);
          res(m);
        }
      };
    });
  } catch (e) {
    waiting.failed(e instanceof Error ? e.message : String(e));
    sock.destroy();
    line();
    process.exitCode = 1;
    return;
  }
  waiting.stop();

  if (answer.t !== "pairAccept") {
    fail("the other machine declined");
    sock.destroy();
    line();
    process.exitCode = 1;
    return;
  }

  const peer = peerFromCert(answer.certPem, answer.name, host, answer.controlPort, answer.relayPort);
  rule("verify");
  kv("machine", c.bold(peer.name));
  kv("address", `${peer.host}:${peer.controlPort}`);
  kv("fingerprint", c.yellow(shortFp(peer.fingerprint)));
  line();
  const yes = await confirm("do these match what they see on their screen?");
  if (!yes) {
    warn("aborted — nothing saved");
    sock.destroy();
    line();
    process.exitCode = 1;
    return;
  }
  addPeer(peer);
  ok(`paired with ${c.bold(peer.name)} — ${loadPeers().length} peer(s) total`);
  line();
  step("they should now run: weld node");
  step("you can then run:   weld status");
  line();
  sock.destroy();
}

async function listen(controlPort: number): Promise<void> {
  const id = getIdentity();
  const cfg = loadConfig();
  const code = process.env.WELD_PAIR_CODE || String(Math.floor(100000 + Math.random() * 900000));
  banner("0.1.0", "pair — waiting for a request");

  const ips = lanIps();
  box(
    [
      `${c.gray("code")}         ${c.bold(c.cyan(code))}`,
      `${c.gray("your ips")}     ${ips.join(", ") || "none detected"}`,
      `${c.gray("port")}         ${controlPort}`,
    ],
    "share with your friend"
  );
  line();
  info("on the other machine run:");
  bullet(
    c.bold(`weld pair ${code} --host ${ips[0] ?? "<your-ip>"}`) +
      (controlPort === 7100 ? "" : ` --port ${controlPort}`)
  );
  line();
  kv("my fingerprint", c.yellow(shortFp(id.fingerprint)));
  line();
  const spinner = new Spinner("listening… ctrl+c to cancel");

  await new Promise<void>((resolve) => {
    const server = tls.createServer({ cert: id.certPem, key: id.keyPem }, (sock) => {
      sock.setEncoding("utf8");
      let handler: (m: Msg) => void = () => {};
      const jl = new JsonLines((d) => sock.write(d), (m) => void handler(m));
      sock.on("data", (d: string) => jl.feed(d));
      sock.on("error", () => {});
      handler = async (m: Msg) => {
        if (m.t !== "pairRequest") return;
        if (m.code !== code) {
          jl.send({ t: "pairDeny" });
          return;
        }
        spinner.stop();
        const peer = peerFromCert(
          m.certPem,
          m.name,
          sock.remoteAddress || "127.0.0.1",
          m.controlPort,
          m.relayPort
        );
        rule("incoming request");
        kv("machine", c.bold(peer.name));
        kv("address", peer.host);
        kv("fingerprint", c.yellow(shortFp(peer.fingerprint)));
        line();
        const yes = await confirm("accept this machine into your cluster?");
        if (!yes) {
          jl.send({ t: "pairDeny" });
          warn("declined");
          line();
          sock.destroy();
          server.close();
          resolve();
          return;
        }
        jl.send({
          t: "pairAccept",
          name: machineName(),
          certPem: id.certPem,
          controlPort: cfg.controlPort,
          relayPort: cfg.relayPort,
        });
        addPeer(peer);
        ok(`paired with ${c.bold(peer.name)} — ${loadPeers().length} peer(s) total`);
        line();
        step("start donating your gpu with: weld node");
        line();
        setTimeout(() => {
          sock.destroy();
          server.close();
          resolve();
        }, 250);
      };
    });
    server.on("error", (e) => {
      spinner.failed(`cannot listen on :${controlPort} — ${e.message}`);
      resolve();
      process.exitCode = 1;
    });
    server.listen(controlPort);
  });
}
