import * as net from "node:net";
import * as crypto from "node:crypto";
import { ControlServer, startRelay } from "../core/tunnel/server.js";
import { connectControl, openRelay } from "../core/tunnel/client.js";
import { addPeer, loadPeers, savePeers, PeerEntry } from "../core/peers.js";
import { getIdentity, machineName } from "../core/identity.js";
import { collectLocal } from "../core/telemetry.js";
import { banner, c, fail, kv, line, ok, rule, sleep } from "../ui.js";

const CONTROL = 7390;
const RELAY = 7391;
const FAKE_RPC = 7392;

async function main(): Promise<void> {
  banner("0.1.0", "loopback transport test");
  const id = getIdentity();
  const original = loadPeers();

  const sink = net.createServer((s) => s.pipe(s));
  await new Promise<void>((r) => sink.listen(FAKE_RPC, "127.0.0.1", () => r()));

  const server = new ControlServer(
    {
      onJoin: async () => {},
      onSessionEnd: () => {},
      telemetry: async () => ({ t: "telemetry", ...collectLocal(true) }),
    },
    FAKE_RPC
  );

  const self: PeerEntry = {
    id: id.nodeId,
    name: machineName() + "-self",
    fingerprint: id.fingerprint,
    certPem: id.certPem,
    host: "127.0.0.1",
    controlPort: CONTROL,
    relayPort: RELAY,
    addedAt: new Date().toISOString(),
  };
  addPeer(self);

  await server.listen(CONTROL);
  await startRelay(RELAY, FAKE_RPC);
  ok(`control :${CONTROL}  relay :${RELAY}  fake-rpc :${FAKE_RPC}`);

  rule("control channel");
  const conn = await connectControl(self, 5000);
  const tel = await conn.request(
    { t: "hello", nodeId: id.nodeId, name: "tester", build: "test" },
    (m) => m.t === "telemetry",
    5000
  );
  if (tel.t !== "telemetry") throw new Error("no telemetry received");
  ok(`telemetry from ${c.bold(tel.name)} — ${tel.gpus.length} gpu(s), ${tel.ramFreeMB}MB ram free`);
  const t0 = Date.now();
  await conn.request({ t: "ping", ts: t0 }, (m) => m.t === "pong", 3000);
  ok(`ping/pong ${Date.now() - t0}ms`);
  const joined = await conn.request(
    { t: "join", sessionId: "test", build: "test" },
    (m) => m.t === "joined",
    5000
  );
  ok(`join handshake: ${joined.t === "joined" && joined.ok ? "accepted" : "refused"}`);

  rule("relay throughput");
  const map = await openRelay(self);
  const sock = net.connect(map.port, "127.0.0.1");
  await new Promise<void>((r) => sock.once("connect", () => r()));
  const sent = crypto.createHash("sha256");
  const back = crypto.createHash("sha256");
  let received = 0;
  const MB = 1024 * 1024;
  const TOTAL = 64;
  const done = new Promise<void>((resolve) => {
    sock.on("data", (d: Buffer) => {
      back.update(d);
      received += d.length;
      if (received >= TOTAL * MB) resolve();
    });
  });
  const start = Date.now();
  for (let i = 0; i < TOTAL; i++) {
    const chunk = crypto.randomBytes(MB);
    sent.update(chunk);
    if (!sock.write(chunk)) await new Promise<void>((r) => sock.once("drain", () => r()));
  }
  await done;
  const secs = (Date.now() - start) / 1000;
  const a = sent.digest("hex");
  const b = back.digest("hex");
  kv("bytes", `${(received / 1e6).toFixed(0)}MB round-tripped`);
  kv("throughput", `${(received / 1e6 / secs).toFixed(0)} MB/s through mTLS`);
  kv("sha256 out", a.slice(0, 32));
  kv("sha256 back", b.slice(0, 32));

  sock.destroy();
  map.close();
  conn.close();
  server.close();
  sink.close();
  savePeers(original);

  line();
  if (a !== b) {
    fail("data corrupted in tunnel");
    process.exit(1);
  }
  ok("PASS — control channel + mTLS relay verified, peers.json restored");
  line();
  await sleep(100);
  process.exit(0);
}

void main();
