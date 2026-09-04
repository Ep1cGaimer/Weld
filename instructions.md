# Weld — Complete Build Instructions

> **Note:** this is the original phase-by-phase build guide. The shipped code in `src/`
> diverged from it in a few places while getting v1 working: `src/ui.ts` replaced
> `@clack/prompts`, the GGUF metadata type enum was corrected (string = 8, array = 9),
> HTTP 416 is treated as "download already complete", and `weld peers` was added.
> `README.md` is the source of truth for how the tool behaves.

You are building `weld`: an npm CLI that lets friends pool GPUs (Windows CUDA + Mac Metal + CPU) into one cluster over llama.cpp's RPC, with mTLS pairing, tunneled traffic, and an OpenAI-compatible endpoint on your machine.

**Runtime:** Node.js ≥ 20, TypeScript, zero native npm modules. (You can *develop* with Bun if you like — every API used is `node:*` so both work — but the product targets npm/Node.)

**Conventions used below:**
- Every step is either `make a file` (path + full contents, type it exactly) or `run` (bash commands + expected output).
- Phases end with a **VERIFY** step. Do not continue until it passes.
- `WELD_HOME` env var overrides `~/.weld` — this is how you simulate two machines on one laptop.
- One rule throughout: **we never write C++**. Weld only spawns llama.cpp binaries and tunnels sockets.

---

# PHASE 0 — Skeleton

## STEP 1 — create the repo

```bash
mkdir weld && cd weld
git init
npm init -y
```

## STEP 2 — make `.gitignore`

```
node_modules/
dist/
.weld/
.weld-a/
.weld-b/
*.gguf
```

## STEP 3 — make `package.json` (replace everything)

```json
{
  "name": "weld-llm",
  "version": "0.1.0",
  "type": "module",
  "engines": { "node": ">=20" },
  "bin": { "weld": "dist/cli.js" },
  "scripts": {
    "build": "tsc",
    "watch": "tsc -w",
    "weld": "node dist/cli.js"
  },
  "dependencies": {
    "@clack/prompts": "^0.7.0",
    "commander": "^12.1.0",
    "node-forge": "^1.3.1"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "@types/node-forge": "^1.3.0",
    "typescript": "^5.5.0"
  }
}
```

## STEP 4 — make `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src"]
}
```

## STEP 5 — make `src/util/paths.ts`

```ts
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

const root = process.env.WELD_HOME || join(homedir(), ".weld");

export const paths = {
  root,
  keys: join(root, "keys"),
  peers: join(root, "peers.json"),
  config: join(root, "config.json"),
  models: join(root, "models"),
  catalog: join(root, "models", "catalog.json"),
  bin: join(root, "bin"),
  cache: join(root, "cache"),
  rpcCache: join(root, "rpc-cache"),
  logs: join(root, "logs"),
};

const dirs = [
  paths.root,
  paths.keys,
  paths.models,
  paths.bin,
  paths.cache,
  paths.rpcCache,
  paths.logs,
];

export function ensureWeldHome(): void {
  for (const d of dirs) mkdirSync(d, { recursive: true });
}
```

## STEP 6 — make `src/util/store.ts`

```ts
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, file);
}
```

## STEP 7 — make `src/util/config.ts`

```ts
import { readJson } from "./store.js";
import { paths } from "./paths.js";

export interface WeldConfig {
  controlPort: number;
  relayPort: number;
  rpcPort: number;
  apiPort: number;
}

function envInt(name: string, d: number): number {
  const v = process.env[name];
  return v ? parseInt(v, 10) : d;
}

export function loadConfig(): WeldConfig {
  const f = readJson<Partial<WeldConfig>>(paths.config, {});
  return {
    controlPort: envInt("WELD_CONTROL_PORT", f.controlPort ?? 7100),
    relayPort: envInt("WELD_RELAY_PORT", f.relayPort ?? 7101),
    rpcPort: envInt("WELD_RPC_PORT", f.rpcPort ?? 50052),
    apiPort: envInt("WELD_API_PORT", f.apiPort ?? 8080),
  };
}
```

## STEP 8 — make `src/cli.ts` (FINAL version — you never edit this file again)

```ts
#!/usr/bin/env node
import { Command } from "commander";
import { cmdSetup } from "./cli/setup.js";
import { cmdPair } from "./cli/pair.js";
import { cmdNode } from "./cli/node.js";
import { cmdModels } from "./cli/modelscli.js";
import { cmdStatus } from "./cli/status.js";
import { cmdDoctor } from "./cli/doctor.js";
import { cmdRun } from "./cli/run.js";

const program = new Command();
program.name("weld").description("pool GPUs with friends over llama.cpp rpc").version("0.1.0");

program.command("setup").description("install pinned llama.cpp binaries").action(cmdSetup);

program
  .command("pair")
  .description("pair with another machine")
  .argument("[code]", "pairing code shown by the other machine")
  .option("--host <host>", "ip of the machine showing the code")
  .option("--port <port>", "control port of that machine", "7100")
  .action(cmdPair);

program.command("node").description("run as gpu donor").action(cmdNode);

const models = program.command("models").description("model management");
models.command("list").action(() => cmdModels("list"));
models.command("search <q>").action((q: string) => cmdModels("search", q));
models.command("files <repo>").action((repo: string) => cmdModels("files", repo));
models
  .command("download <repo> <file>")
  .action((repo: string, file: string) => cmdModels("download", repo, file));
models.command("import <path>").action((path: string) => cmdModels("import", path));

program.command("status").description("cluster overview").action(cmdStatus);
program.command("doctor").description("diagnostics").action(cmdDoctor);

program
  .command("run")
  .description("run a model across the cluster")
  .argument("<model>", "model id or gguf path")
  .option("--ctx <n>", "context size", "8192")
  .option("--exclude <name>", "exclude peer by name/id", (v: string, a: string[]) => [...a, v], [] as string[])
  .action(cmdRun);

program.parse();
```

## STEP 9 — make the 7 command stubs

`src/cli/setup.ts`:
```ts
export async function cmdSetup(): Promise<void> {}
```

`src/cli/node.ts`:
```ts
export async function cmdNode(): Promise<void> {}
```

`src/cli/status.ts`:
```ts
export async function cmdStatus(): Promise<void> {}
```

`src/cli/doctor.ts`:
```ts
export async function cmdDoctor(): Promise<void> {}
```

`src/cli/pair.ts`:
```ts
export async function cmdPair(code?: string, opts?: { host?: string; port?: string }): Promise<void> {}
```

`src/cli/modelscli.ts`:
```ts
export async function cmdModels(cmd: string, a?: string, b?: string): Promise<void> {}
```

`src/cli/run.ts`:
```ts
export async function cmdRun(model: string, opts: { ctx: string; exclude: string[] }): Promise<void> {}
```

## STEP 10 — VERIFY

```bash
npm install
npm run build
node dist/cli.js --version
```
Expected: `0.1.0`

Then (optional, makes `weld` global — rerun `npm link` never again, it links to `dist/`):
```bash
npm link
weld --version
```
If `npm link` fights you on Windows, use `npm run weld -- <args>` everywhere instead of `weld <args>`.

---

# PHASE 1 — Identity & peers

## STEP 11 — make `src/core/identity.ts`

```ts
import forge from "node-forge";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { paths, ensureWeldHome } from "../util/paths.js";
import { readJson, writeJson } from "../util/store.js";

export interface Identity {
  certPem: string;
  keyPem: string;
  fingerprint: string;
  nodeId: string;
}

const ADJ = ["iron", "copper", "cobalt", "titan", "neon", "onyx", "quartz", "zinc"];
const NOUN = ["falcon", "otter", "lynx", "heron", "ibex", "viper", "wolf", "crow"];

let cached: Identity | null = null;

export function fpOfCert(certPem: string): { fingerprint: string; nodeId: string } {
  const der = forge.pki.pemToDer(certPem);
  const hex = forge.md.sha256.create().update(der.bytes()).digest().toHex().toUpperCase();
  return {
    fingerprint: hex.match(/.{2}/g)!.join(":"),
    nodeId: hex.slice(0, 16),
  };
}

export function machineName(): string {
  const cfg = readJson<{ name?: string }>(paths.config, {});
  if (cfg.name) return cfg.name;
  const name = `${ADJ[randomBytes(1)[0] % ADJ.length]}-${NOUN[randomBytes(1)[0] % NOUN.length]}`;
  writeJson(paths.config, { ...cfg, name });
  return name;
}

export function getIdentity(): Identity {
  if (cached) return cached;
  ensureWeldHome();
  const certFile = join(paths.keys, "cert.pem");
  const keyFile = join(paths.keys, "key.pem");
  if (existsSync(certFile) && existsSync(keyFile)) {
    const certPem = readFileSync(certFile, "utf8");
    const keyPem = readFileSync(keyFile, "utf8");
    cached = { certPem, keyPem, ...fpOfCert(certPem) };
    return cached;
  }
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomBytes(8).toString("hex");
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 3650 * 86400000);
  const attrs = [{ name: "commonName", value: "weld-node" }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const certPem = forge.pki.certificateToPem(cert);
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);
  writeFileSync(certFile, certPem);
  writeFileSync(keyFile, keyPem);
  cached = { certPem, keyPem, ...fpOfCert(certPem) };
  return cached;
}
```

## STEP 12 — make `src/core/peers.ts`

```ts
import { readJson, writeJson } from "../util/store.js";
import { paths } from "../util/paths.js";
import { fpOfCert } from "./identity.js";

export interface PeerEntry {
  id: string;
  name: string;
  fingerprint: string;
  certPem: string;
  host: string;
  controlPort: number;
  relayPort: number;
  addedAt: string;
}

export function loadPeers(): PeerEntry[] {
  return readJson<PeerEntry[]>(paths.peers, []);
}

export function savePeers(peers: PeerEntry[]): void {
  writeJson(paths.peers, peers);
}

export function addPeer(peer: PeerEntry): PeerEntry[] {
  const peers = loadPeers().filter((p) => p.id !== peer.id);
  peers.push(peer);
  savePeers(peers);
  return peers;
}

export function peerFingerprints(): Set<string> {
  return new Set(loadPeers().map((p) => p.fingerprint));
}

export function peerFromCert(
  certPem: string,
  name: string,
  host: string,
  controlPort: number,
  relayPort: number
): PeerEntry {
  const { fingerprint, nodeId } = fpOfCert(certPem);
  const cleanHost = host.replace("::ffff:", "");
  return {
    id: nodeId,
    name,
    fingerprint,
    certPem,
    host: cleanHost,
    controlPort,
    relayPort,
    addedAt: new Date().toISOString(),
  };
}
```

## STEP 13 — make `src/cli/pair.ts` (temporary version — proves identity, real flow in Phase 3)

```ts
import { getIdentity, machineName } from "../core/identity.js";
import { loadPeers } from "../core/peers.js";
import { ensureWeldHome } from "../util/paths.js";

export async function cmdPair(code?: string, opts?: { host?: string; port?: string }): Promise<void> {
  ensureWeldHome();
  const id = getIdentity();
  console.log(`this machine: ${machineName()} (${id.nodeId})`);
  console.log(`fingerprint: ${id.fingerprint}`);
  console.log(`paired peers: ${loadPeers().length} (real pairing arrives in phase 3)`);
}
```

## STEP 14 — VERIFY

```bash
npm run build
weld pair
```
Expected: your machine name (`copper-lynx` style), a `AA:BB:CC:...` fingerprint, `paired peers: 0`.
Run it twice → same fingerprint both times (keys persist on disk).

---

# PHASE 2 — TLS transport (the hard part)

## STEP 15 — make `src/core/proto.ts` (the wire protocol — every message Weld ever sends)

```ts
export interface GpuInfo {
  name: string;
  vramTotalMB: number;
  vramFreeMB: number;
}

export interface Telemetry {
  nodeId: string;
  name: string;
  gpus: GpuInfo[];
  ramFreeMB: number;
  build: string;
}

export type Msg =
  | { t: "hello"; nodeId: string; name: string; build: string }
  | { t: "helloAck" }
  | { t: "ping"; ts: number }
  | { t: "pong"; ts: number }
  | ({ t: "telemetry" } & Telemetry)
  | { t: "join"; sessionId: string; build: string }
  | { t: "joined"; ok: true; rpcPort: number }
  | { t: "joined"; ok: false; error: string }
  | { t: "leave" }
  | { t: "pairRequest"; code: string; name: string; certPem: string; controlPort: number; relayPort: number }
  | { t: "pairAccept"; name: string; certPem: string; controlPort: number; relayPort: number }
  | { t: "pairDeny" };

export class JsonLines {
  private buf = "";
  constructor(
    private writeRaw: (s: string) => boolean,
    private onMsg: (m: Msg) => void
  ) {}
  feed(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      try {
        this.onMsg(JSON.parse(line));
      } catch {
        /* malformed line — ignore */
      }
    }
  }
  send(m: Msg): void {
    this.writeRaw(JSON.stringify(m) + "\n");
  }
}
```

## STEP 16 — make `src/core/tunnel/server.ts` (donor side)

```ts
import * as tls from "node:tls";
import * as net from "node:net";
import { getIdentity } from "../identity.js";
import { peerFingerprints } from "../peers.js";
import { JsonLines, Msg } from "../proto.js";

export interface ControlHandlers {
  onJoin: (sessionId: string) => Promise<void>;
  onLeave: () => void;
  telemetry: () => Promise<Msg>;
}

export class ControlServer {
  private server?: tls.Server;
  private conns = new Map<tls.TLSSocket, JsonLines>();

  constructor(private handlers: ControlHandlers, private rpcPort: number) {}

  listen(port: number): Promise<void> {
    const id = getIdentity();
    this.server = tls.createServer(
      { cert: id.certPem, key: id.keyPem, requestCert: true, rejectUnauthorized: false },
      (s) => {
        // re-read peers on every connection so freshly paired peers work
        const fps = peerFingerprints();
        const c = s.getPeerCertificate();
        if (!c || !c.fingerprint256 || !fps.has(c.fingerprint256)) {
          s.destroy();
          return;
        }
        const jl = new JsonLines((d) => s.write(d), (m) => void this.onMsg(s, m));
        this.conns.set(s, jl);
        s.setEncoding("utf8");
        s.on("data", (d) => jl.feed(d));
        s.on("close", () => {
          this.conns.delete(s);
        });
      }
    );
    return new Promise((res) => this.server!.listen(port, () => res()));
  }

  private async onMsg(s: tls.TLSSocket, m: Msg): Promise<void> {
    const jl = this.conns.get(s);
    if (!jl) return;
    switch (m.t) {
      case "hello":
        jl.send({ t: "helloAck" });
        jl.send(await this.handlers.telemetry());
        break;
      case "ping":
        jl.send({ t: "pong", ts: m.ts });
        break;
      case "join":
        try {
          await this.handlers.onJoin(m.sessionId);
          jl.send({ t: "joined", ok: true, rpcPort: this.rpcPort });
        } catch (e) {
          jl.send({ t: "joined", ok: false, error: String(e) });
        }
        break;
      case "leave":
        this.handlers.onLeave();
        break;
    }
  }

  broadcast(m: Msg): void {
    for (const jl of this.conns.values()) jl.send(m);
  }

  close(): void {
    this.server?.close();
    for (const s of this.conns.keys()) s.destroy();
  }
}

export function startRelay(relayPort: number, rpcPort: number): Promise<number> {
  const id = getIdentity();
  const server = tls.createServer(
    { cert: id.certPem, key: id.keyPem, requestCert: true, rejectUnauthorized: false },
    (s) => {
      const fps = peerFingerprints();
      const c = s.getPeerCertificate();
      if (!c || !c.fingerprint256 || !fps.has(c.fingerprint256)) {
        s.destroy();
        return;
      }
      const rpc = net.connect(rpcPort, "127.0.0.1");
      rpc.on("connect", () => {
        s.pipe(rpc);
        rpc.pipe(s);
      });
      s.on("close", () => rpc.destroy());
      s.on("error", () => rpc.destroy());
      rpc.on("close", () => s.destroy());
      rpc.on("error", () => s.destroy());
    }
  );
  return new Promise((res) => server.listen(relayPort, () => res(relayPort)));
}
```

## STEP 17 — make `src/core/tunnel/client.ts` (head side)

```ts
import * as tls from "node:tls";
import * as net from "node:net";
import { getIdentity } from "../identity.js";
import { JsonLines, Msg } from "../proto.js";
import { PeerEntry } from "../peers.js";

export interface ControlConn {
  send(m: Msg): void;
  request(m: Msg, match: (m: Msg) => boolean, ms?: number): Promise<Msg>;
  onMessage(cb: (m: Msg) => void): void;
  onClose(cb: () => void): void;
  readonly closed: Promise<void>;
  close(): void;
}

export function connectControl(peer: PeerEntry, timeoutMs = 4000): Promise<ControlConn> {
  const id = getIdentity();
  return new Promise((res, rej) => {
    const sock = tls.connect(
      {
        host: peer.host,
        port: peer.controlPort,
        cert: id.certPem,
        key: id.keyPem,
        rejectUnauthorized: false,
      },
      () => {
        const c = sock.getPeerCertificate();
        if (!c || c.fingerprint256 !== peer.fingerprint) {
          sock.destroy();
          rej(new Error(`cert mismatch on ${peer.host}:${peer.controlPort}`));
          return;
        }
        const hooks: ((m: Msg) => void)[] = [];
        const pending = new Set<(m: Msg) => boolean>();
        const jl = new JsonLines((d) => sock.write(d), (m) => {
          for (const h of [...hooks]) h(m);
          for (const pm of [...pending]) if (pm(m)) pending.delete(pm);
        });
        sock.setEncoding("utf8");
        sock.on("data", (d) => jl.feed(d));
        sock.on("error", () => {});
        let closedResolve: () => void;
        const closed = new Promise<void>((r) => (closedResolve = r));
        const closeHandlers: (() => void)[] = [];
        sock.on("close", () => {
          closedResolve();
          for (const h of [...closeHandlers]) h();
        });
        const conn: ControlConn = {
          send: (m) => jl.send(m),
          request: (m, match, ms = 8000) =>
            new Promise<Msg>((r2, rj) => {
              const timer = setTimeout(() => {
                pending.delete(match);
                rj(new Error("timeout"));
              }, ms);
              pending.add((msg) => {
                if (match(msg)) {
                  clearTimeout(timer);
                  r2(msg);
                  return true;
                }
                return false;
              });
              jl.send(m);
            }),
          onMessage: (cb) => hooks.push(cb),
          onClose: (cb) => closeHandlers.push(cb),
          get closed() {
            return closed;
          },
          close: () => sock.destroy(),
        };
        res(conn);
      }
    );
    sock.on("error", (e) => rej(e));
    setTimeout(() => {
      if (!sock.destroyed) sock.destroy();
      rej(new Error("connect timeout"));
    }, timeoutMs);
  });
}

export function openRelay(peer: PeerEntry): Promise<{ port: number; close: () => void }> {
  const id = getIdentity();
  const server = net.createServer((local) => {
    const remote = tls.connect(
      { host: peer.host, port: peer.relayPort, cert: id.certPem, key: id.keyPem, rejectUnauthorized: false },
      () => {
        const c = remote.getPeerCertificate();
        if (!c || c.fingerprint256 !== peer.fingerprint) {
          local.destroy();
          remote.destroy();
          return;
        }
        local.pipe(remote);
        remote.pipe(local);
      }
    );
    local.on("close", () => remote.destroy());
    local.on("error", () => remote.destroy());
    remote.on("error", () => local.destroy());
    remote.on("close", () => local.destroy());
  });
  return new Promise((res) =>
    server.listen(0, "127.0.0.1", () =>
      res({ port: (server.address() as net.AddressInfo).port, close: () => server.close() })
    )
  );
}
```

## STEP 18 — make `src/loopback/pipe-test.ts` (proves the entire transport)

```ts
import * as net from "node:net";
import * as crypto from "node:crypto";
import { ControlServer, startRelay } from "../core/tunnel/server.js";
import { connectControl, openRelay } from "../core/tunnel/client.js";
import { addPeer, loadPeers, savePeers } from "../core/peers.js";
import { getIdentity, machineName } from "../core/identity.js";

async function main(): Promise<void> {
  const id = getIdentity();
  const savedPeers = loadPeers();

  // fake "rpc-server": echoes everything back
  const sink = net.createServer((s) => s.pipe(s));
  await new Promise<void>((r) => sink.listen(50999, "127.0.0.1", r));

  const server = new ControlServer(
    {
      onJoin: async () => {},
      onLeave: () => {},
      telemetry: async () => ({
        t: "telemetry",
        nodeId: id.nodeId,
        name: machineName(),
        gpus: [],
        ramFreeMB: 1024,
        build: "test",
      }),
    },
    50999
  );
  await server.listen(7200);
  await startRelay(7201, 50999);

  // loopback trick: pair with OURSELVES
  addPeer({
    id: id.nodeId,
    name: "self",
    fingerprint: id.fingerprint,
    certPem: id.certPem,
    host: "127.0.0.1",
    controlPort: 7200,
    relayPort: 7201,
    addedAt: new Date().toISOString(),
  });

  // 1) control channel: hello -> helloAck
  const conn = await connectControl(
    { host: "127.0.0.1", controlPort: 7200, relayPort: 7201 } as never,
    5000
  );
  const first = await conn.request(
    { t: "hello", nodeId: "x", name: "x", build: "test" },
    (m) => m.t === "helloAck" || m.t === "telemetry",
    5000
  );
  console.log("control channel ok, got:", first.t);

  // 2) relay: push 100MB through the mTLS tunnel, hash the echo
  const map = await openRelay({ host: "127.0.0.1", relayPort: 7201 } as never);
  const sock = net.connect(map.port, "127.0.0.1");
  const sent = crypto.createHash("sha256");
  const recv = crypto.createHash("sha256");
  let recvBytes = 0;
  sock.on("data", (d: Buffer) => {
    recv.update(d);
    recvBytes += d.length;
  });
  await new Promise<void>((r) => sock.once("connect", r));
  const MB = 1024 * 1024;
  for (let i = 0; i < 100; i++) {
    const chunk = crypto.randomBytes(MB);
    sent.update(chunk);
    if (!sock.write(chunk)) await new Promise<void>((r) => sock.once("drain", r));
  }
  sock.end();
  await new Promise<void>((r) => sock.once("close", r));
  const a = sent.digest("hex");
  const b = recv.digest("hex");
  console.log("sent   :", a);
  console.log("echoed :", b, `(${recvBytes} bytes)`);

  savePeers(savedPeers); // undo self-pairing
  conn.close();
  server.close();
  sink.close();

  if (a !== b) {
    console.error("FAIL — tunnel corrupted data");
    process.exit(1);
  }
  console.log("PASS — 100MB round-tripped through the mTLS relay, hashes match");
  process.exit(0);
}

void main();
```

## STEP 19 — VERIFY

```bash
npm run build
node dist/loopback/pipe-test.js
```
Expected:
```
control channel ok, got: helloAck
sent   : <hex>
echoed : <hex> (104857600 bytes)
PASS — 100MB round-tripped through the mTLS relay, hashes match
```
The two hashes must differ from each other's *labels* but the PASS line only prints if sent-hash == echoed-hash (the echo returns your exact bytes). If you see PASS: your TLS transport, JSON-lines protocol, and relay all work. This was the riskiest part of the project.

---

# PHASE 3 — Pairing

## STEP 20 — overwrite `src/cli/pair.ts` (real version)

```ts
import * as tls from "node:tls";
import * as p from "@clack/prompts";
import { networkInterfaces } from "node:os";
import { getIdentity, machineName } from "../core/identity.js";
import { addPeer, loadPeers, peerFromCert } from "../core/peers.js";
import { JsonLines, Msg } from "../core/proto.js";
import { loadConfig } from "../util/config.js";
import { ensureWeldHome } from "../util/paths.js";

function myIps(): string[] {
  const ips: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list ?? []) {
      if (String(i.family) === "IPv4" && !i.internal) ips.push(i.address);
    }
  }
  return ips;
}

export async function cmdPair(code?: string, opts?: { host?: string; port?: string }): Promise<void> {
  ensureWeldHome();
  const id = getIdentity();
  const cfg = loadConfig();
  if (code && opts?.host) {
    await dial(code, opts.host, parseInt(opts.port || "7100", 10));
  } else if (code) {
    console.log("pass --host <ip> when pairing with a code. the other machine's `weld pair` shows its ips.");
    console.log(`example: weld pair ${code} --host 192.168.1.42 --port ${cfg.controlPort}`);
  } else {
    await listenForPair(cfg.controlPort);
  }
}

async function dial(code: string, host: string, port: number): Promise<void> {
  const id = getIdentity();
  const cfg = loadConfig();
  p.intro(`dialing ${host}:${port}`);
  let handler: (m: Msg) => void = () => {};
  const sock = tls.connect({ host, port, rejectUnauthorized: false });
  sock.setEncoding("utf8");
  const jl = new JsonLines((d) => sock.write(d), (m) => handler(m));
  sock.on("data", (d) => jl.feed(d));
  await new Promise<void>((res, rej) => {
    sock.once("secureConnect", res);
    sock.once("error", rej);
    setTimeout(() => {
      if (!sock.destroyed) sock.destroy();
      rej(new Error("connect timeout — wrong ip/port? firewall?"));
    }, 8000);
  });
  jl.send({
    t: "pairRequest",
    code,
    name: machineName(),
    certPem: id.certPem,
    controlPort: cfg.controlPort,
    relayPort: cfg.relayPort,
  });
  const answer = await new Promise<Msg>((res, rej) => {
    const timer = setTimeout(() => rej(new Error("pairing timed out — was the code right?")), 120000);
    handler = (m) => {
      if (m.t === "pairAccept" || m.t === "pairDeny") {
        clearTimeout(timer);
        res(m);
      }
    };
  });
  if (answer.t === "pairDeny") {
    p.outro("they said no");
    sock.destroy();
    return;
  }
  if (answer.t !== "pairAccept") {
    p.outro("unexpected response");
    sock.destroy();
    return;
  }
  const peer = peerFromCert(answer.certPem, answer.name, host, answer.controlPort, answer.relayPort);
  addPeer(peer);
  p.outro(`paired with ${peer.name} (${host}) — ${loadPeers().length} peer(s) total`);
  sock.destroy();
}

async function listenForPair(controlPort: number): Promise<void> {
  const id = getIdentity();
  const cfg = loadConfig();
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const ips = myIps();
  p.intro("waiting for a pair request");
  console.log(`pairing code : ${code}`);
  console.log(`your ips     : ${ips.join(", ") || "(none found — use manual host later)"}`);
  console.log(`other machine:  weld pair ${code} --host <one-of-those-ips> --port ${controlPort}`);

  const server = tls.createServer({ cert: id.certPem, key: id.keyPem }, (sock) => {
    sock.setEncoding("utf8");
    let handler: (m: Msg) => void = () => {};
    const jl = new JsonLines((d) => sock.write(d), (m) => void handler(m));
    sock.on("data", (d) => jl.feed(d));
    handler = async (m: Msg) => {
      if (m.t !== "pairRequest") return;
      if (m.code !== code) {
        jl.send({ t: "pairDeny" });
        return;
      }
      const theirFp = peerFromCert(m.certPem, m.name, "x", 0, 0).fingerprint;
      const yes = await p.confirm({
        message: `pair with ${m.name} [${theirFp}] from ${sock.remoteAddress}?`,
      });
      if (!yes) {
        jl.send({ t: "pairDeny" });
        return;
      }
      jl.send({
        t: "pairAccept",
        name: machineName(),
        certPem: id.certPem,
        controlPort: cfg.controlPort,
        relayPort: cfg.relayPort,
      });
      const peer = peerFromCert(
        m.certPem,
        m.name,
        sock.remoteAddress || "127.0.0.1",
        m.controlPort,
        m.relayPort
      );
      addPeer(peer);
      p.outro(`paired with ${peer.name} — ${loadPeers().length} peer(s) total`);
      server.close();
      sock.destroy();
      process.exit(0);
    };
  });
  server.listen(controlPort);
  console.log(`listening on :${controlPort} — ctrl+c to cancel`);
  await new Promise<void>(() => {});
}
```

## STEP 21 — VERIFY (two terminals = two machines)

```bash
# terminal 1:
export WELD_HOME=~/.weld-a
weld pair
# note the code (e.g. 482913) and use 127.0.0.1 as host

# terminal 2:
export WELD_HOME=~/.weld-b
weld pair 482913 --host 127.0.0.1 --port 7100

# terminal 1 asks: pair with <name-b> [<fingerprint>] from 127.0.0.1? -> press y
```
Expected: terminal 2 prints `paired with <name-a>`, terminal 1 prints `paired with <name-b>`, then both exit. Check that `~/.weld-a/peers.json` and `~/.weld-b/peers.json` each contain one entry.
You now have two fake machines on your laptop. Everything from here on uses them.

---

# PHASE 4 — Binaries (`weld setup`)

## STEP 22 — make `src/core/binaries.ts`

```ts
import { existsSync, statSync, openSync, writeSync, closeSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { paths, ensureWeldHome } from "../util/paths.js";
import { readJson, writeJson } from "../util/store.js";

export const PINNED_BUILD = "b10621";

function base(): string {
  return `https://github.com/ggml-org/llama.cpp/releases/download/${PINNED_BUILD}`;
}

export function binDir(): string {
  return join(paths.bin, PINNED_BUILD);
}

const EXE = process.platform === "win32" ? ".exe" : "";

export function llamaServerPath(): string {
  return join(binDir(), "llama-server" + EXE);
}

export function rpcServerPath(): string {
  for (const n of ["ggml-rpc-server", "rpc-server"]) {
    const p = join(binDir(), n + EXE);
    if (existsSync(p)) return p;
  }
  return join(binDir(), "ggml-rpc-server" + EXE);
}

export function installedBuild(): string | null {
  const m = readJson<{ build?: string }>(join(binDir(), "manifest.json"), {});
  return m.build ?? null;
}

export async function downloadFile(
  url: string,
  dest: string,
  onProgress?: (got: number, total: number) => void
): Promise<void> {
  const start = existsSync(dest) ? statSync(dest).size : 0;
  const headers: Record<string, string> = {};
  if (start > 0) headers.range = `bytes=${start}-`;
  const res = await fetch(url, { headers });
  if (res.status !== 200 && res.status !== 206) {
    throw new Error(`download failed ${res.status} for ${url}`);
  }
  let append = res.status === 206;
  if (res.status === 200 && start > 0) append = false;
  const total = (append ? start : 0) + Number(res.headers.get("content-length") || 0);
  const fd = openSync(dest, append ? "a" : "w");
  const rd = res.body!.getReader();
  let got = append ? start : 0;
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    writeSync(fd, value);
    got += value.length;
    onProgress?.(got, total);
  }
  closeSync(fd);
}

export function extract(file: string, dir: string): void {
  const r = spawnSync("tar", ["-xf", file, "-C", dir], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`extract failed for ${file}`);
}

export function listDevices(): string {
  const r = spawnSync(llamaServerPath(), ["--list-devices"], { encoding: "utf8" });
  return (r.stdout || "") + (r.stderr || "");
}

export function assetFor(kind: "cpu" | "cuda" | "cudart"): string {
  if (process.platform === "win32") {
    if (kind === "cpu") return `${base()}/llama-${PINNED_BUILD}-bin-win-cpu-x64.zip`;
    if (kind === "cuda") return `${base()}/llama-${PINNED_BUILD}-bin-win-cuda-12.4-x64.zip`;
    return `${base()}/cudart-llama-bin-win-cuda-12.4-x64.zip`;
  }
  if (process.platform === "darwin") {
    if (process.arch === "arm64") return `${base()}/llama-${PINNED_BUILD}-bin-macos-arm64.tar.gz`;
    return `${base()}/llama-${PINNED_BUILD}-bin-macos-x64.tar.gz`;
  }
  return `${base()}/llama-${PINNED_BUILD}-bin-ubuntu-x64.tar.gz`;
}

export function writeManifest(): void {
  ensureWeldHome();
  writeJson(join(binDir(), "manifest.json"), {
    build: PINNED_BUILD,
    platform: `${process.platform}-${process.arch}`,
    at: new Date().toISOString(),
  });
}
```

## STEP 23 — overwrite `src/cli/setup.ts`

```ts
import * as p from "@clack/prompts";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { ensureWeldHome, paths } from "../util/paths.js";
import {
  assetFor,
  binDir,
  downloadFile,
  extract,
  llamaServerPath,
  listDevices,
  PINNED_BUILD,
  writeManifest,
} from "../core/binaries.js";

function progress(got: number, total: number): void {
  process.stdout.write(`\r${(got / 1e6).toFixed(0)}/${(total / 1e6).toFixed(0)} MB   `);
}

export async function cmdSetup(): Promise<void> {
  ensureWeldHome();
  const dir = binDir();
  mkdirSync(dir, { recursive: true });
  p.intro(`weld setup — llama.cpp ${PINNED_BUILD}`);

  p.log.info("downloading base build (cpu / metal)...");
  await downloadFile(assetFor("cpu"), join(paths.cache, "base.zip"), progress);
  console.log();
  extract(join(paths.cache, "base.zip"), dir);

  if (process.platform === "win32") {
    const hasNvidia = !spawnSync("nvidia-smi", ["-L"], { encoding: "utf8" }).error;
    if (hasNvidia) {
      p.log.info("nvidia detected — cuda backend + runtime (big downloads, get coffee)...");
      await downloadFile(assetFor("cuda"), join(paths.cache, "cuda.zip"), progress);
      console.log();
      extract(join(paths.cache, "cuda.zip"), dir);
      await downloadFile(assetFor("cudart"), join(paths.cache, "cudart.zip"), progress);
      console.log();
      extract(join(paths.cache, "cudart.zip"), dir);
    } else {
      p.log.warn("no nvidia gpu — cpu backend only for now");
    }
  }

  writeManifest();
  console.log();
  console.log(listDevices().split("\n").filter((l) => l.trim()).slice(0, 8).join("\n"));

  if (process.platform === "win32") {
    p.log.info("if pairing/status fail across machines, run as admin:");
    console.log(`  netsh advfirewall firewall add rule name="weld" dir=in action=allow protocol=TCP localport=7100,7101`);
  }
  p.outro(`binaries at ${dir}`);
}
```

## STEP 24 — VERIFY

```bash
npm run build
weld setup
```
Expected: download progress (base ~18MB; on Windows+Nvidia also the ~250MB CUDA zip and ~390MB cudart zip), then llama.cpp's device list (e.g. `CUDA0: NVIDIA GeForce RTX 4070 ...` or Metal on Mac), then the binaries path.

Then confirm the binaries run:
```bash
# use the path it printed, e.g.:
~/.weld/bin/b10621/llama-server.exe --version    # windows
~/.weld/bin/b10621/llama-server --version       # mac
```
Expected: `version: ... (b10621)`.

Note: `weld setup` is idempotent — rerunning re-downloads (resume kicks in) and re-extracts safely.

---

# PHASE 5 — GGUF header + fit math

## STEP 25 — make `src/core/gguf.ts`

```ts
import { openSync, readSync, closeSync, fstatSync } from "node:fs";
import { Buffer } from "node:buffer";

export interface GgufInfo {
  meta: Record<string, string | number | boolean>;
  weightsBytes: number;
  tensorCount: number;
}

class Reader {
  pos = 0;
  constructor(private fd: number) {}
  private take(bytes: number): Buffer {
    const b = Buffer.alloc(bytes);
    readSync(this.fd, b, 0, bytes, this.pos);
    this.pos += bytes;
    return b;
  }
  u8(): number {
    return this.take(1)[0];
  }
  int(bytes: number, signed: boolean): number | bigint {
    const b = this.take(bytes);
    if (bytes <= 6) return signed ? b.readIntLE(0, bytes) : b.readUIntLE(0, bytes);
    return signed ? b.readBigInt64LE(0) : b.readBigUInt64LE(0);
  }
  u32(): number {
    return this.int(4, false) as number;
  }
  u64(): number {
    return Number(this.int(8, false));
  }
  str(): string {
    const len = this.u64();
    return this.take(len).toString("utf8");
  }
  f32(): number {
    return this.take(4).readFloatLE(0);
  }
  f64(): number {
    return this.take(8).readDoubleLE(0);
  }
}

function readValue(r: Reader, t: number): string | number | boolean | (string | number | boolean)[] {
  switch (t) {
    case 0: return r.u8();
    case 1: return Number(r.int(2, false));
    case 2: return r.u32();
    case 3: return r.u64();
    case 4: return Number(r.int(1, true));
    case 5: return Number(r.int(2, true));
    case 6: return Number(r.int(4, true));
    case 7: return Number(r.int(8, true));
    case 8: return r.f32();
    case 9: return r.f64();
    case 10: return r.u8() === 1;
    case 11: return r.str();
    case 12: {
      const et = r.u32();
      const n = r.u64();
      const out: (string | number | boolean)[] = [];
      for (let i = 0; i < Math.min(n, 64); i++) out.push(readValue(r, et) as string | number | boolean);
      for (let i = 64; i < n; i++) readValue(r, et);
      return out;
    }
    default:
      return 0;
  }
}

export function parseGgufHeader(file: string): GgufInfo {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const r = new Reader(fd);
    const magic = Buffer.alloc(4);
    readSync(fd, magic, 0, 4, 0);
    r.pos = 4;
    if (magic.toString() !== "GGUF") throw new Error("not a gguf file");
    r.u32(); // version
    const tensorCount = r.u64();
    const kvCount = r.u64();
    const meta: Record<string, string | number | boolean> = {};
    for (let i = 0; i < kvCount; i++) {
      const t = r.u32();
      const key = r.str();
      const v = readValue(r, t);
      if (typeof v !== "object") meta[key] = v;
    }
    for (let i = 0; i < tensorCount; i++) {
      r.str(); // tensor name
      const nd = r.u32();
      for (let d = 0; d < nd; d++) r.u64();
      r.u32(); // type
      r.u64(); // offset
    }
    const dataStart = (r.pos + 31) & ~31;
    return { meta, tensorCount, weightsBytes: size - dataStart };
  } finally {
    closeSync(fd);
  }
}
```

## STEP 26 — make `src/core/plan.ts`

```ts
import { GgufInfo } from "./gguf.js";
import { Telemetry } from "./proto.js";

export interface FitResult {
  fits: boolean;
  poolMB: number;
  needMB: number;
  headroomMB: number;
  advice: string;
}

export function poolOf(t: Telemetry): number {
  const vram = t.gpus.reduce((a, g) => a + g.vramFreeMB, 0);
  // with a gpu: vram + some ram for cpu spill; cpu-only: most of ram
  return vram > 0 ? vram + t.ramFreeMB * 0.2 : t.ramFreeMB * 0.7;
}

export function kvBytes(meta: GgufInfo["meta"], ctx: number): number {
  const arch = String(meta["general.architecture"] || "");
  if (!arch) return 0;
  const layers = Number(meta[`${arch}.block_count`] || 32);
  const embd = Number(meta[`${arch}.embedding_length`] || 4096);
  const heads = Number(meta[`${arch}.attention.head_count`] || 32);
  const kvHeads = Number(meta[`${arch}.attention.head_count_kv`] || heads);
  const keyLen = Number(meta[`${arch}.attention.key_length`] || embd / heads);
  const nEmbdKv = kvHeads * keyLen;
  // K + V, f16 = 2 bytes each
  return 2 * layers * ctx * nEmbdKv * 2;
}

export function fit(info: GgufInfo, ctx: number, nodes: Telemetry[]): FitResult {
  const poolMB = nodes.reduce((a, n) => a + poolOf(n), 0);
  const kvMB = (kvBytes(info.meta, ctx) || info.weightsBytes * 0.15) / 1e6;
  const needMB = info.weightsBytes / 1e6 + kvMB * 1.15;
  const headroomMB = poolMB - needMB;
  const advice =
    headroomMB >= 0
      ? `fits with ${(headroomMB / 1000).toFixed(1)}GB headroom`
      : `short by ${(-headroomMB / 1000).toFixed(1)}GB — add a node or a smaller quant`;
  return { fits: headroomMB >= 0, poolMB, needMB, headroomMB, advice };
}
```

## STEP 27 — make `src/cli/modelscli.ts` (list + import now, HF comes Phase 6)

```ts
import { parseGgufHeader } from "../core/gguf.js";
import { readJson, writeJson } from "../util/store.js";
import { paths } from "../util/paths.js";
import { basename, resolve } from "node:path";

export interface CatalogEntry {
  id: string;
  file: string;
  path: string;
  bytes: number;
  arch: string;
  addedAt: string;
}

export function loadCatalog(): CatalogEntry[] {
  return readJson<CatalogEntry[]>(paths.catalog, []);
}

export function saveCatalog(cat: CatalogEntry[]): void {
  writeJson(paths.catalog, cat);
}

export function catalogEntry(path: string): CatalogEntry {
  const info = parseGgufHeader(path);
  const id = basename(path).replace(/\.gguf$/i, "");
  return {
    id,
    file: basename(path),
    path,
    bytes: info.weightsBytes,
    arch: String(info.meta["general.architecture"] || "?"),
    addedAt: new Date().toISOString(),
  };
}

export async function cmdModels(cmd: string, a?: string, b?: string): Promise<void> {
  if (cmd === "import" && a) {
    const path = resolve(a);
    const entry = catalogEntry(path);
    saveCatalog([...loadCatalog().filter((c) => c.id !== entry.id), entry]);
    const info = parseGgufHeader(path);
    console.log(
      `${entry.id}: ${info.tensorCount} tensors, ${(info.weightsBytes / 1e9).toFixed(1)}GB weights, arch=${entry.arch}`
    );
    return;
  }
  if (cmd === "list") {
    for (const c of loadCatalog()) {
      console.log(`${c.id.padEnd(40)} ${(c.bytes / 1e9).toFixed(1)}GB  ${c.arch}`);
    }
    return;
  }
  console.log(`${cmd} arrives in phase 6`);
}
```

## STEP 28 — VERIFY (needs any .gguf on disk)

```bash
npm run build
weld models import C:\path\to\some-model.gguf
weld models list
```
Expected: `name: NNNN tensors, XX.XGB weights, arch=<llama|qwen2|...>`, and the GB within ~1% of the file size on disk. If you don't have a GGUF yet, download a small one after Phase 6's `search`/`download` exists and come back.

---

# PHASE 6 — HF downloads, telemetry, supervisor

## STEP 29 — make `src/core/models.ts`

```ts
export interface HfModel {
  id: string;
  downloads: number;
}

export async function hfSearch(q: string): Promise<HfModel[]> {
  const res = await fetch(
    `https://huggingface.co/api/models?search=${encodeURIComponent(q)}&filter=gguf&sort=downloads&limit=20`
  );
  const data = (await res.json()) as { id: string; downloads: number }[];
  return data.map((d) => ({ id: d.id, downloads: d.downloads }));
}

export async function hfFiles(repo: string): Promise<{ name: string; size: number }[]> {
  const res = await fetch(`https://huggingface.co/api/models/${repo}?blobs=true`);
  const data = (await res.json()) as { siblings: { rfilename: string; size?: number }[] };
  return data.siblings
    .filter((s) => s.rfilename.endsWith(".gguf"))
    .map((s) => ({ name: s.rfilename, size: s.size || 0 }));
}

export function hfUrl(repo: string, file: string): string {
  return `https://huggingface.co/${repo}/resolve/main/${file}`;
}
```

## STEP 30 — make `src/core/telemetry.ts`

```ts
import { spawnSync } from "node:child_process";
import { freemem } from "node:os";
import { getIdentity, machineName } from "./identity.js";
import { installedBuild } from "./binaries.js";
import { GpuInfo, Telemetry } from "./proto.js";

export function collectLocal(): Telemetry {
  const id = getIdentity();
  const gpus: GpuInfo[] = [];
  if (process.platform === "win32" || process.platform === "linux") {
    const r = spawnSync(
      "nvidia-smi",
      ["--query-gpu=name,memory.total,memory.free", "--format=csv,noheader,nounits"],
      { encoding: "utf8" }
    );
    if (!r.error && r.stdout && r.stdout.trim()) {
      for (const line of r.stdout.trim().split("\n")) {
        const [name, total, free] = line.split(",").map((s) => s.trim());
        gpus.push({ name, vramTotalMB: Number(total), vramFreeMB: Number(free) });
      }
    }
  }
  return {
    nodeId: id.nodeId,
    name: machineName(),
    gpus,
    ramFreeMB: Math.round(freemem() / 1e6),
    build: installedBuild() ?? "none",
  };
}
```

## STEP 31 — make `src/proc/supervisor.ts`

```ts
import { spawn } from "node:child_process";

export interface Proc {
  pid: number;
  exited: Promise<number | null>;
  stderr: string;
  stop(): Promise<void>;
}

export function spawnProc(
  bin: string,
  args: string[],
  opts: { env?: Record<string, string>; onErr?: (s: string) => void } = {}
): Proc {
  const child = spawn(bin, args, {
    stdio: ["ignore", "ignore", "pipe"],
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    windowsHide: true,
  });
  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => {
    const s = d.toString();
    stderr += s;
    if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    opts.onErr?.(s);
  });
  const exited = new Promise<number | null>((res) => child.on("exit", (code) => res(code)));
  return {
    pid: child.pid ?? -1,
    exited,
    get stderr() {
      return stderr;
    },
    stop: () =>
      new Promise<void>((res) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          res();
          return;
        }
        if (process.platform === "win32") {
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
        } else {
          child.kill("SIGTERM");
          setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {}
          }, 3000);
        }
        void exited.then(() => res());
      }),
  };
}
```

## STEP 32 — overwrite `src/cli/modelscli.ts` (full version with HF)

```ts
import { join } from "node:path";
import { existsSync } from "node:fs";
import { parseGgufHeader } from "../core/gguf.js";
import { downloadFile } from "../core/binaries.js";
import { hfSearch, hfFiles, hfUrl } from "../core/models.js";
import { paths, ensureWeldHome } from "../util/paths.js";

export interface CatalogEntry {
  id: string;
  file: string;
  path: string;
  bytes: number;
  arch: string;
  addedAt: string;
}

import { readJson, writeJson } from "../util/store.js";
import { basename, resolve } from "node:path";

export function loadCatalog(): CatalogEntry[] {
  return readJson<CatalogEntry[]>(paths.catalog, []);
}

export function saveCatalog(cat: CatalogEntry[]): void {
  writeJson(paths.catalog, cat);
}

export function catalogEntry(path: string): CatalogEntry {
  const info = parseGgufHeader(path);
  const id = basename(path).replace(/\.gguf$/i, "");
  return {
    id,
    file: basename(path),
    path,
    bytes: info.weightsBytes,
    arch: String(info.meta["general.architecture"] || "?"),
    addedAt: new Date().toISOString(),
  };
}

async function download(repo: string, file: string): Promise<void> {
  ensureWeldHome();
  const dest = join(paths.models, basename(file));
  console.log(`downloading ${file} -> ${dest}`);
  await downloadFile(hfUrl(repo, file), dest, (got, total) =>
    process.stdout.write(`\r${(got / 1e6).toFixed(0)}/${(total / 1e6).toFixed(0)} MB   `)
  );
  console.log();
  if (!existsSync(dest)) throw new Error("download failed");
  const entry = catalogEntry(dest);
  saveCatalog([...loadCatalog().filter((c) => c.id !== entry.id), entry]);
  console.log(`added to catalog: ${entry.id} (${(entry.bytes / 1e9).toFixed(1)}GB)`);
}

export async function cmdModels(cmd: string, a?: string, b?: string): Promise<void> {
  if (cmd === "search" && a) {
    for (const m of await hfSearch(a)) {
      console.log(`${m.id.padEnd(55)} ${m.downloads}`);
    }
    return;
  }
  if (cmd === "files" && a) {
    for (const f of await hfFiles(a)) {
      console.log(`${f.name.padEnd(60)} ${(f.size / 1e9).toFixed(1)}GB`);
    }
    return;
  }
  if (cmd === "download" && a && b) {
    await download(a, b);
    return;
  }
  if (cmd === "import" && a) {
    const entry = catalogEntry(resolve(a));
    saveCatalog([...loadCatalog().filter((c) => c.id !== entry.id), entry]);
    console.log(`added to catalog: ${entry.id} (${(entry.bytes / 1e9).toFixed(1)}GB, ${entry.arch})`);
    return;
  }
  if (cmd === "list") {
    for (const c of loadCatalog()) {
      console.log(`${c.id.padEnd(40)} ${(c.bytes / 1e9).toFixed(1)}GB  ${c.arch}`);
    }
    return;
  }
  console.log(`usage: weld models list|search <q>|files <repo>|download <repo> <file>|import <path>`);
}
```

## STEP 33 — VERIFY

```bash
npm run build
weld models search qwen3
weld models files ggml-org/Qwen3-1.7B-GGUF
weld models download ggml-org/Qwen3-1.7B-GGUF Qwen3-1.7B-Q4_K_M.gguf
```
Expected: search lists repos, files lists GGUFs with sizes, download shows progress then `added to catalog: Qwen3-1.7B-Q4_K_M`. Ctrl+C mid-download then rerun → it resumes (range header).

---

# PHASE 7 — Donor daemon + run engine (the boss fight)

## STEP 34 — make `src/cli/node.ts` (the donor daemon)

```ts
import * as p from "@clack/prompts";
import { networkInterfaces } from "node:os";
import { mkdirSync } from "node:fs";
import { ensureWeldHome, paths } from "../util/paths.js";
import { loadConfig } from "../util/config.js";
import { getIdentity, machineName } from "../core/identity.js";
import { collectLocal } from "../core/telemetry.js";
import { ControlServer, startRelay } from "../core/tunnel/server.js";
import { spawnProc, Proc } from "../proc/supervisor.js";
import { rpcServerPath } from "../core/binaries.js";

function myIps(): string[] {
  const ips: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list ?? []) {
      if (String(i.family) === "IPv4" && !i.internal) ips.push(i.address);
    }
  }
  return ips;
}

export async function cmdNode(): Promise<void> {
  ensureWeldHome();
  const cfg = loadConfig();
  const id = getIdentity();

  let rpcProc: Proc | null = null;
  let activeSession = false;

  const server = new ControlServer(
    {
      onJoin: async () => {
        if (rpcProc) return;
        mkdirSync(paths.rpcCache, { recursive: true });
        rpcProc = spawnProc(
          rpcServerPath(),
          ["--host", "127.0.0.1", "-p", String(cfg.rpcPort), "-c", paths.rpcCache],
          { onErr: (s) => process.stderr.write(s) }
        );
        activeSession = true;
      },
      onLeave: () => {
        // only tear down if an actual session was running — status probes also disconnect
        if (!activeSession) return;
        activeSession = false;
        if (rpcProc) {
          const proc = rpcProc;
          rpcProc = null;
          void proc.stop();
        }
      },
      telemetry: async () => ({ t: "telemetry", ...collectLocal() }),
    },
    cfg.rpcPort
  );

  await server.listen(cfg.controlPort);
  await startRelay(cfg.relayPort, cfg.rpcPort);

  // push telemetry to connected heads every 2s
  setInterval(() => server.broadcast({ t: "telemetry", ...collectLocal() }), 2000);

  p.intro(`weld node — ${machineName()} (${id.nodeId.slice(0, 8)})`);
  console.log(`control :${cfg.controlPort}   relay :${cfg.relayPort}   rpc 127.0.0.1:${cfg.rpcPort}`);
  console.log(`ips: ${myIps().join(", ")}`);
  console.log(`donating gpu to paired heads. ctrl+c to stop.`);

  const shutdown = () => {
    void (async () => {
      if (rpcProc) await rpcProc.stop();
      server.close();
      process.exit(0);
    })();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await new Promise<void>(() => {}); // stay alive
}
```

**Note:** if the pinned llama.cpp build rejects `--host` on rpc-server (flag names change between builds), remove `"--host", "127.0.0.1",` from the args — the relay still only accepts paired certs, but keep rpc off public networks either way.

## STEP 35 — make `src/cli/run.ts` (the head — the whole point)

```ts
import * as p from "@clack/prompts";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { loadConfig } from "../util/config.js";
import { loadPeers, PeerEntry } from "../core/peers.js";
import { connectControl, ControlConn, openRelay } from "../core/tunnel/client.js";
import { collectLocal } from "../core/telemetry.js";
import { Telemetry } from "../core/proto.js";
import { parseGgufHeader } from "../core/gguf.js";
import { fit } from "../core/plan.js";
import { spawnProc, Proc } from "../proc/supervisor.js";
import { llamaServerPath, PINNED_BUILD } from "../core/binaries.js";
import { readJson } from "../util/store.js";
import { paths } from "../util/paths.js";
import { loadCatalog } from "./modelscli.js";

function portFree(port: number): Promise<boolean> {
  return new Promise((res) => {
    const net = require("node:net") as typeof import("node:net");
    const srv = net.createServer();
    srv.once("error", () => res(false));
    srv.once("listening", () => srv.close(() => res(true)));
    srv.listen(port, "127.0.0.1");
  });
}

function classifyLlamaExit(code: number | null, stderr: string): string {
  if (/rpc/i.test(stderr)) return "a donor connection dropped (its rpc-server died or the network cut out)";
  if (/cuda|ggml-cuda|vram|out of memory/i.test(stderr)) return "gpu/out-of-memory error — try a smaller quant or --ctx";
  if (/failed to load model|gguf/i.test(stderr)) return "model file problem — re-download or import again";
  return `llama-server exited (code ${code})`;
}

export async function cmdRun(model: string, opts: { ctx: string; exclude: string[] }): Promise<void> {
  const cfg = loadConfig();
  const ctx = parseInt(opts.ctx, 10) || 8192;

  // 1) resolve model
  const entry = loadCatalog().find((c) => c.id === model);
  const modelPath = entry ? entry.path : resolve(model);
  if (!existsSync(modelPath)) {
    p.outro(`model not found: ${modelPath} — weld models download/import first`);
    process.exit(1);
  }
  const info = parseGgufHeader(modelPath);

  // 2) gather cluster
  const head = collectLocal();
  const excluded = opts.exclude ?? [];
  const peers = loadPeers().filter((pe) => !excluded.includes(pe.name) && !excluded.includes(pe.id));
  const conns: { peer: PeerEntry; conn: ControlConn; telemetry?: Telemetry }[] = [];
  for (const peer of peers) {
    try {
      const conn = await connectControl(peer, 3000);
      conn.send({ t: "hello", nodeId: head.nodeId, name: head.name, build: head.build });
      conn.onMessage((m) => {
        if (m.t === "telemetry") {
          for (const c of conns) {
            if (c.conn === conn) c.telemetry = m;
          }
        }
      });
      conns.push({ peer, conn });
    } catch {
      p.log.warn(`peer ${peer.name} unreachable — skipping`);
    }
  }
  await new Promise((r) => setTimeout(r, 2000)); // let telemetry arrive

  const nodes: Telemetry[] = [
    head,
    ...conns.map((c) => c.telemetry).filter((t): t is Telemetry => !!t),
  ];

  // 3) build pin check
  for (const n of nodes) {
    if (n.build !== PINNED_BUILD) {
      p.outro(
        `node ${n.name} reports build ${n.build}, head pinned to ${PINNED_BUILD} — everyone re-run: weld setup`
      );
      process.exit(1);
    }
  }

  // 4) fit check
  const f = fit(info, ctx, nodes);
  console.log(
    `pool  : ${(f.poolMB / 1000).toFixed(1)}GB   need: ${(f.needMB / 1000).toFixed(1)}GB   -> ${f.advice}`
  );
  if (!f.fits) {
    p.outro("not enough pooled memory");
    process.exit(1);
  }

  // 5) api port free?
  if (!(await portFree(cfg.apiPort))) {
    p.outro(`port ${cfg.apiPort} already in use — close the other server or set WELD_API_PORT`);
    process.exit(1);
  }

  // 6) join donors (they spawn rpc-server on their side)
  for (const c of conns) {
    const resp = await c.conn.request(
      { t: "join", sessionId: `s-${Date.now()}`, build: PINNED_BUILD },
      (m) => m.t === "joined",
      20000
    );
    if (resp.t !== "joined" || !resp.ok) {
      p.outro(`node ${c.peer.name} refused: ${resp.t === "joined" ? resp.error : "timeout"}`);
      process.exit(1);
    }
  }
  if (conns.length) p.log.step(`${conns.length} donor(s) joined`);

  // 7) tunnels: local port per peer
  const maps: { port: number; close: () => void }[] = [];
  for (const c of conns) maps.push(await openRelay(c.peer));

  // 8) llama-server (local gpu + remote rpc devices)
  const args = [
    "-m", modelPath,
    "--host", "127.0.0.1",
    "--port", String(cfg.apiPort),
    "-c", String(ctx),
    "-ngl", "999",
  ];
  if (maps.length) args.push("--rpc", maps.map((m) => `127.0.0.1:${m.port}`).join(","));
  p.log.step(`starting llama-server with ${maps.length} remote device(s)...`);
  const llama: Proc = spawnProc(llamaServerPath(), args, {
    onErr: (s) => process.stderr.write(s),
  });

  // 9) health poll (first load streams weights over the LAN — can take minutes)
  let ready = false;
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${cfg.apiPort}/health`);
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {}
    if ((await Promise.race([llama.exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 200))])) as boolean) {
      break; // llama died during load
    }
    process.stdout.write(`\rwaiting for model... ${Math.round((deadline - Date.now()) / 1000)}s   `);
  }
  console.log();
  if (!ready) {
    const code = await llama.exited;
    console.error(classifyLlamaExit(code, llama.stderr));
    await teardown(llama, maps, conns);
    process.exit(1);
  }

  console.log();
  p.outro(`API ready: http://127.0.0.1:${cfg.apiPort}/v1  (ctrl+c to stop)`);

  // 10) supervise: llama exit OR any donor dying
  const failure: Promise<{ kind: string; name?: string; code?: number | null }> = Promise.race([
    llama.exited.then((code) => ({ kind: "llama", code })),
    ...conns.map((c) =>
      c.conn.closed.then(() => ({ kind: "peer", name: c.peer.name }))
    ),
  ]);
  const sigint = new Promise<"sigint">((r) => {
    process.once("SIGINT", () => r("sigint"));
    process.once("SIGTERM", () => r("sigint"));
  });
  const what = await Promise.race([failure, sigint]);

  if (what === "sigint") {
    await teardown(llama, maps, conns);
    process.exit(0);
  }
  if (what.kind === "peer") {
    console.error(`\ndonor "${what.name}" dropped mid-session.`);
    await teardown(llama, maps, conns);
    const again = await p.confirm({ message: `rerun without ${what.name}?` });
    if (again) {
      return cmdRun(model, { ctx: opts.ctx, exclude: [...excluded, what.name!] });
    }
    process.exit(1);
  }
  console.error(`\n${classifyLlamaExit(what.code ?? null, llama.stderr)}`);
  await teardown(llama, maps, conns);
  process.exit(1);
}

async function teardown(
  llama: Proc,
  maps: { close: () => void }[],
  conns: { conn: ControlConn }[]
): Promise<void> {
  await llama.stop();
  for (const m of maps) m.close();
  for (const c of conns) {
    try {
      c.conn.send({ t: "leave" });
    } catch {}
    c.conn.close();
  }
}
```

(TS note: `require("node:net")` inside ESM is ugly — if the compiler complains, add `import * as net from "node:net";` at the top of the file and use it in `portFree`. Do that from the start; keep the require out.)

## STEP 36 — fix the import (do this while typing 35)

At the top of `src/cli/run.ts`, add:
```ts
import * as net from "node:net";
```
and in `portFree` replace `const net = require("node:net") as typeof import("node:net");` with nothing (use the imported `net` directly).

## STEP 37 — VERIFY: the loopback cluster (your project WORKS at this step)

Three terminals:

```bash
# terminal 1 — donor A:
export WELD_HOME=~/.weld-a
export WELD_CONTROL_PORT=7100
export WELD_RELAY_PORT=7101
export WELD_RPC_PORT=50052
weld pair          # note code, then in terminal 2 dial it (only first time)
```

```bash
# terminal 2 — donor B:
export WELD_HOME=~/.weld-b
export WELD_CONTROL_PORT=7200
export WELD_RELAY_PORT=7201
export WELD_RPC_PORT=50062
weld pair <code-from-t1> --host 127.0.0.1 --port 7100   # first time only
weld node
```

```bash
# terminal 1 — after pairing, become the second donor:
weld node
```

```bash
# terminal 3 — the head (your main WELD_HOME, the one with the downloaded model):
# pair with both donors:
weld pair <code-from-t1> --host 127.0.0.1 --port 7100
# (t1 must be running `weld pair` again for this — pair one at a time, then run `weld node` again)
weld run Qwen3-1.7B-Q4_K_M
```

Expected in terminal 3:
```
pool  : XX.XGB   need: X.XGB   -> fits with XX.XGB headroom
2 donor(s) joined
starting llama-server with 2 remote device(s)...
API ready: http://127.0.0.1:8080/v1
```
Then the moment of truth:
```bash
curl http://127.0.0.1:8080/v1/chat/completions -H "Content-Type: application/json" -d '{"messages":[{"role":"user","content":"say hi to the cluster"}]}'
```
A JSON completion comes back — generated across three "machines" (all localhost, CPU-only devices). **This is the project working.**

## STEP 38 — loopback pairing flow, spelled out (do it once, slowly)

`weld pair` (listener) and `weld node` (daemon) both want port 7100. So on each donor WELD_HOME: run `weld pair`, accept the incoming pair, it exits; then start `weld node` which now owns 7100 forever after. Pair each donor with the head once; after that, only `weld node` + `weld run` are needed daily.

---

# PHASE 8 — Failure handling drills (no new files — you verify the code you typed)

## STEP 39 — run each failure and confirm Weld reacts

1. **Donor dies mid-session:** start the loopback cluster, `weld run`, get a completion, then Ctrl+C one donor's `weld node`.
   Expected in head: `donor "<name>" dropped mid-session.` → rerun offer. Say `y` → session restarts minus that donor.

2. **Peer unreachable at startup:** kill both donors, `weld run`.
   Expected: `peer <name> unreachable — skipping` (x2), then head runs solo (llama-server with no `--rpc`), API still works on your GPU/CPU alone.

3. **Model too big:** `weld run <big-model> --ctx 131072` against a small pool.
   Expected: `short by XX.XGB — add a node or a smaller quant`, exit 1.

4. **Build mismatch:** hand-edit `~/.weld-a/bin/b10621/manifest.json` to `"build": "b00000"`, rerun.
   Expected: hard stop telling everyone to `weld setup`.

5. **API port taken:** `npx http-server -p 8080` in another shell, then `weld run`.
   Expected: `port 8080 already in use`.

6. **Download resume:** start `weld models download ...`, Ctrl+C at 50%, rerun.
   Expected: resumes from ~50%.

Fix anything that doesn't behave as described before moving on.

---

# PHASE 9 — status, doctor, README

## STEP 40 — make `src/cli/status.ts`

```ts
import { getIdentity, machineName } from "../core/identity.js";
import { loadPeers } from "../core/peers.js";
import { connectControl } from "../core/tunnel/client.js";
import { collectLocal } from "../core/telemetry.js";
import { Telemetry } from "../core/proto.js";
import { poolOf } from "../core/plan.js";
import { ensureWeldHome } from "../util/paths.js";

function row(t: Telemetry, status: string): void {
  const gpu = t.gpus.length
    ? t.gpus.map((g) => `${g.name} ${(g.vramFreeMB / 1000).toFixed(1)}GB free`).join("; ")
    : "cpu";
  console.log(
    `${t.name.padEnd(14)} ${status.padEnd(10)} ${t.build.padEnd(8)} ${String((t.ramFreeMB / 1000).toFixed(0)).padStart(4)}GB ram  ${gpu}`
  );
}

export async function cmdStatus(): Promise<void> {
  ensureWeldHome();
  const id = getIdentity();
  const head = collectLocal();
  console.log(`cluster from ${machineName()} (${id.nodeId.slice(0, 8)})`);
  console.log("");
  row(head, "head");
  let pool = poolOf(head);
  for (const peer of loadPeers()) {
    try {
      const conn = await connectControl(peer, 2500);
      conn.send({ t: "hello", nodeId: head.nodeId, name: head.name, build: head.build });
      const tel = await new Promise<Telemetry>((res, rej) => {
        const t1 = setTimeout(() => rej(new Error("timeout")), 3000);
        conn.onMessage((m) => {
          if (m.t === "telemetry") {
            clearTimeout(t1);
            res(m);
          }
        });
      });
      conn.close();
      pool += poolOf(tel);
      row(tel, "online");
    } catch {
      console.log(`${peer.name.padEnd(14)} offline    ${peer.host}`);
    }
  }
  console.log("");
  console.log(`pooled capacity: ~${(pool / 1000).toFixed(1)}GB — you can run models up to about that size`);
}
```

## STEP 41 — make `src/cli/doctor.ts`

```ts
import { existsSync, statfsSync } from "node:fs";
import * as net from "node:net";
import { spawnSync } from "node:child_process";
import { getIdentity, machineName } from "../core/identity.js";
import { loadPeers } from "../core/peers.js";
import { connectControl } from "../core/tunnel/client.js";
import { collectLocal } from "../core/telemetry.js";
import {
  installedBuild,
  llamaServerPath,
  PINNED_BUILD,
  rpcServerPath,
} from "../core/binaries.js";
import { paths, ensureWeldHome } from "../util/paths.js";

function ok(msg: string): void {
  console.log(`  [ok]   ${msg}`);
}
function bad(msg: string): void {
  console.log(`  [FAIL] ${msg}`);
}

function portFree(port: number): Promise<boolean> {
  return new Promise((res) => {
    const srv = net.createServer();
    srv.once("error", () => res(false));
    srv.once("listening", () => srv.close(() => res(true)));
    srv.listen(port, "127.0.0.1");
  });
}

export async function cmdDoctor(): Promise<void> {
  ensureWeldHome();
  const id = getIdentity();
  console.log(`weld doctor — ${machineName()} (${id.nodeId.slice(0, 8)})`);

  console.log("\nbinaries:");
  if (existsSync(llamaServerPath())) ok(`llama-server at ${llamaServerPath()}`);
  else bad(`llama-server missing — run: weld setup`);
  if (existsSync(rpcServerPath())) ok("rpc-server present");
  else bad(`rpc-server missing — run: weld setup`);
  const b = installedBuild();
  if (b === PINNED_BUILD) ok(`build ${b} matches pin`);
  else bad(`build is ${b ?? "none"}, pin is ${PINNED_BUILD}`);
  if (existsSync(llamaServerPath())) {
    const r = spawnSync(llamaServerPath(), ["--version"], { encoding: "utf8", timeout: 10000 });
    if (!r.error) ok(`llama-server runs: ${(r.stdout || r.stderr || "").split("\n")[0].trim()}`);
    else bad(`llama-server failed to execute: ${r.error.message}`);
  }

  console.log("\nports (should be free when idle):");
  for (const [name, port] of [
    ["api 8080", 8080],
    ["control 7100", 7100],
    ["relay 7101", 7101],
    ["rpc 50052", 50052],
  ] as const) {
    console.log(`  [${(await portFree(port)) ? "ok" : "FAIL"}]   ${name} ${port}`);
  }

  console.log("\ndisk:");
  try {
    const st = statfsSync(paths.models);
    const freeGB = (Number(st.bavail) * Number(st.bsize)) / 1e9;
    ok(`${freeGB.toFixed(0)}GB free for models (${paths.models})`);
  } catch {
    console.log("  [??]    could not read disk info");
  }

  console.log("\nlocal telemetry:");
  const t = collectLocal();
  ok(`gpus: ${t.gpus.length ? t.gpus.map((g) => g.name).join(", ") : "none (cpu mode)"}`);
  ok(`ram free: ${(t.ramFreeMB / 1000).toFixed(1)}GB`);

  console.log("\npeers:");
  const peers = loadPeers();
  if (!peers.length) console.log("  (none paired yet)");
  for (const peer of peers) {
    try {
      const conn = await connectControl(peer, 2500);
      const t0 = Date.now();
      await conn.request({ t: "ping", ts: t0 }, (m) => m.t === "pong", 3000);
      const ms = Date.now() - t0;
      conn.close();
      ok(`${peer.name} (${peer.host}) — ${ms}ms roundtrip`);
    } catch {
      bad(`${peer.name} (${peer.host}) unreachable — is \`weld node\` running there?`);
    }
  }
  console.log("\ndone.");
}
```

## STEP 42 — make `README.md`

```markdown
# weld

pool GPUs with friends. run models too big for any single machine.

    # you (windows, nvidia)                # friend (mac, apple silicon)
    npm i -g weld-llm                      npm i -g weld-llm
    weld setup                             weld setup
    weld pair        -> shows code         weld pair <code> --host <your-ip>
    (fingerprint check, y, on both)

    weld models search qwen3
    weld models download ggml-org/Qwen3-1.7B-GGUF Qwen3-1.7B-Q4_K_M.gguf
    weld run Qwen3-1.7B-Q4_K_M
    -> API: http://127.0.0.1:8080/v1   (openai-compatible)

## how it works
- llama.cpp rpc: your machine (head) runs llama-server; friends' machines (donors)
  run `weld node` and contribute their GPU over an mTLS tunnel.
- the model file lives only on the head. donors cache their slice after first load.
- memory pools: head + donors must jointly fit weights + KV cache. `weld status`
  shows your pooled capacity.

## honest performance expectations
- every token round-trips head <-> donors. wired ethernet strongly preferred.
- first model load streams weights over your LAN (a 17GB model = ~2.5min @ 2.5GbE).
- adding a slow node slows everyone: exclude it with `weld run <model> --exclude <name>`.

## security
- all weld traffic is mutually-authenticated TLS; only machines you paired can connect.
- llama.cpp's rpc protocol itself has no auth — weld tunnels it and binds it to
  localhost on both ends. still: keep the cluster on trusted networks.
```

## STEP 43 — VERIFY

```bash
npm run build
weld status
weld doctor
```
Expected: status prints head row + offline peers (or online if donors running) + pooled capacity; doctor all `[ok]` on a healthy setup.

---

# PHASE 10 — Two real machines (the fun day)

## STEP 44 — the real test

You (Windows) + friend (Mac), same LAN, both on Node 20+:

1. Both: `npm i -g weld-llm` (or `npm link` from your clones), then `weld setup`.
2. You: `weld pair` → read code + your LAN IP to them.
3. Them: `weld pair <code> --host <your-ip>`, you press `y` on the fingerprint.
4. Them: `weld node` and leave it running.
5. You: `weld status` (should show them online + GPU) → `weld run <model>`.
6. `curl` a completion.

Expect an afternoon of reality:
- **Windows firewall** silently eats 7100/7101 → run the netsh command from `weld setup` output as admin, or allow Node through the prompt.
- **mDNS/hostname weirdness** → we don't rely on it; manual `--host` IPs are the v1 path anyway.
- **Latency** shows up in `weld doctor` — if wifi latency is >5ms, expect sluggish tokens; wire up ethernet.
- **rpc-server flag drift** → if donors report "refused" instantly, check the donor terminal for rpc-server argument errors; adjust args in `node.ts` (see note in Step 34).

Every fix becomes a `weld doctor` check or a README line. This day produces your honest benchmark numbers — record them (tok/s per setup: solo vs 2-node, ethernet vs wifi) and put them in the README.

---

# PHASE 11 — CI + publish

## STEP 45 — make `.github/workflows/ci.yml`

```yaml
name: ci
on: [push, pull_request]
jobs:
  test:
    strategy:
      matrix:
        os: [windows-latest, macos-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm run build
      - run: node dist/loopback/pipe-test.js
```

## STEP 46 — publish

Update `package.json` additions (keep existing fields, add):

```json
{
  "description": "pool GPUs with friends over llama.cpp rpc — one openai-compatible endpoint",
  "license": "MIT",
  "files": ["dist"],
  "keywords": ["llama.cpp", "distributed-inference", "rpc", "gguf", "cluster", "llm"],
  "repository": { "type": "git", "url": "git+https://github.com/<you>/weld.git" }
}
```

```bash
git add -A
git commit -m "weld v0.1.0 — pair, node, models, run, status, doctor"
npm run build
npm login        # once
npm publish
```

Then bump the pinned build later with this procedure:
1. edit `PINNED_BUILD` in `src/core/binaries.ts`
2. `weld setup` on your machine, run the Step 37 loopback cluster, get a completion
3. commit + `npm version patch` + publish

---

# Troubleshooting index

| symptom | cause | fix |
|---|---|---|
| `pair` connect timeout | wrong ip / firewall | check ips printed by `weld pair`; run netsh rule (setup output) as admin |
| control connects, relay fails | peer's relay port blocked | `weld doctor` on the peer; open 7101 |
| `joined` ok but llama-server instantly exits, stderr mentions rpc | donor rpc-server failed to start | look at donor terminal; maybe `--host` flag unsupported — Step 34 note |
| tokens are glacial | wifi latency / weak donor | `weld doctor` roundtrips; `--exclude` the weak node |
| first load takes forever | weights streaming over LAN | normal; keep donors' `-c` cache warm (it is), rerun same model |
| `cert mismatch` | peers.json stale (re-paired with fresh keys) | delete the peer entry in `~/.weld/peers.json`, pair again |
| `weld: command not found` after changes | npm link shadow | use `npm run weld --` or re-`npm link` |

---

**Where you are when finished:** a working npm package that turns two laptops and a friendship into one bigger GPU. v2 ideas (pooled download, cache pre-warm, `--head` rotation, pull-mode shards when llama.cpp #26610 merges) live in the conversation — build v1 first.
