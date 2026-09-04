import * as tls from "node:tls";
import * as net from "node:net";
import { getIdentity } from "../identity.js";
import { peerFingerprints } from "../peers.js";
import { JsonLines, Msg } from "../proto.js";

export interface ControlHandlers {
  onJoin: (sessionId: string, peerName: string) => Promise<void>;
  onSessionEnd: (peerName: string) => void;
  telemetry: () => Promise<Msg>;
  onPeerHello?: (name: string) => void;
}

export class ControlServer {
  private server?: tls.Server;
  private conns = new Map<tls.TLSSocket, JsonLines>();
  private names = new Map<tls.TLSSocket, string>();
  private joined = new Set<tls.TLSSocket>();

  constructor(
    private handlers: ControlHandlers,
    private rpcPort: number
  ) {}

  listen(port: number): Promise<void> {
    const id = getIdentity();
    this.server = tls.createServer(
      { cert: id.certPem, key: id.keyPem, requestCert: true, rejectUnauthorized: false },
      (s) => {
        const fps = peerFingerprints();
        const cert = s.getPeerCertificate();
        if (!cert || !cert.fingerprint256 || !fps.has(cert.fingerprint256)) {
          s.destroy();
          return;
        }
        const jl = new JsonLines((d) => s.write(d), (m) => void this.onMsg(s, m));
        this.conns.set(s, jl);
        s.setEncoding("utf8");
        s.on("data", (d: string) => jl.feed(d));
        s.on("error", () => {});
        s.on("close", () => {
          const name = this.names.get(s) ?? "peer";
          const wasJoined = this.joined.delete(s);
          this.conns.delete(s);
          this.names.delete(s);
          if (wasJoined) this.handlers.onSessionEnd(name);
        });
      }
    );
    return new Promise((res, rej) => {
      this.server!.once("error", rej);
      this.server!.listen(port, () => res());
    });
  }

  private async onMsg(s: tls.TLSSocket, m: Msg): Promise<void> {
    const jl = this.conns.get(s);
    if (!jl) return;
    switch (m.t) {
      case "hello":
        this.names.set(s, m.name);
        this.handlers.onPeerHello?.(m.name);
        jl.send({ t: "helloAck" });
        jl.send(await this.handlers.telemetry());
        break;
      case "ping":
        jl.send({ t: "pong", ts: m.ts });
        break;
      case "join":
        try {
          await this.handlers.onJoin(m.sessionId, this.names.get(s) ?? "peer");
          this.joined.add(s);
          jl.send({ t: "joined", ok: true, rpcPort: this.rpcPort });
        } catch (e) {
          jl.send({ t: "joined", ok: false, error: e instanceof Error ? e.message : String(e) });
        }
        break;
      case "leave":
        if (this.joined.delete(s)) this.handlers.onSessionEnd(this.names.get(s) ?? "peer");
        break;
      default:
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
      const cert = s.getPeerCertificate();
      if (!cert || !cert.fingerprint256 || !fps.has(cert.fingerprint256)) {
        s.destroy();
        return;
      }
      const rpc = net.connect(rpcPort, "127.0.0.1");
      rpc.on("connect", () => {
        s.pipe(rpc);
        rpc.pipe(s);
      });
      s.on("error", () => rpc.destroy());
      s.on("close", () => rpc.destroy());
      rpc.on("error", () => s.destroy());
      rpc.on("close", () => s.destroy());
    }
  );
  return new Promise((res, rej) => {
    server.once("error", rej);
    server.listen(relayPort, () => res(relayPort));
  });
}
