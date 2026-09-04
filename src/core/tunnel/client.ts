import * as tls from "node:tls";
import * as net from "node:net";
import { getIdentity } from "../identity.js";
import { JsonLines, Msg } from "../proto.js";
import { PeerEntry } from "../peers.js";

export interface ControlConn {
  send(m: Msg): void;
  request(m: Msg, match: (m: Msg) => boolean, ms?: number): Promise<Msg>;
  onMessage(cb: (m: Msg) => void): void;
  readonly closed: Promise<void>;
  close(): void;
}

export interface RelayMap {
  port: number;
  close(): void;
}

export function connectControl(peer: PeerEntry, timeoutMs = 4000): Promise<ControlConn> {
  const id = getIdentity();
  return new Promise((res, rej) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };
    const sock = tls.connect(
      {
        host: peer.host,
        port: peer.controlPort,
        cert: id.certPem,
        key: id.keyPem,
        rejectUnauthorized: false,
      },
      () => {
        const cert = sock.getPeerCertificate();
        if (!cert || cert.fingerprint256 !== peer.fingerprint) {
          sock.destroy();
          finish(() => rej(new Error(`certificate mismatch for ${peer.name}`)));
          return;
        }
        const hooks: ((m: Msg) => void)[] = [];
        const pending = new Set<(m: Msg) => boolean>();
        const jl = new JsonLines(
          (d) => sock.write(d),
          (m) => {
            for (const h of [...hooks]) h(m);
            for (const p of [...pending]) if (p(m)) pending.delete(p);
          }
        );
        sock.setEncoding("utf8");
        sock.on("data", (d: string) => jl.feed(d));
        let resolveClosed: () => void = () => {};
        const closed = new Promise<void>((r) => (resolveClosed = r));
        sock.on("close", () => resolveClosed());
        finish(() =>
          res({
            send: (m) => {
              if (!sock.destroyed) jl.send(m);
            },
            request: (m, match, ms = 8000) =>
              new Promise<Msg>((r2, rj2) => {
                const timer = setTimeout(() => rj2(new Error("request timed out")), ms);
                pending.add((msg) => {
                  if (!match(msg)) return false;
                  clearTimeout(timer);
                  r2(msg);
                  return true;
                });
                jl.send(m);
              }),
            onMessage: (cb) => hooks.push(cb),
            get closed() {
              return closed;
            },
            close: () => sock.destroy(),
          })
        );
      }
    );
    sock.on("error", (e) => finish(() => rej(e)));
    setTimeout(() => {
      if (!settled) {
        sock.destroy();
        finish(() => rej(new Error(`connection to ${peer.host}:${peer.controlPort} timed out`)));
      }
    }, timeoutMs);
  });
}

export function openRelay(peer: PeerEntry): Promise<RelayMap> {
  const id = getIdentity();
  const sockets = new Set<net.Socket>();
  const server = net.createServer((local) => {
    sockets.add(local);
    const remote = tls.connect(
      {
        host: peer.host,
        port: peer.relayPort,
        cert: id.certPem,
        key: id.keyPem,
        rejectUnauthorized: false,
      },
      () => {
        const cert = remote.getPeerCertificate();
        if (!cert || cert.fingerprint256 !== peer.fingerprint) {
          local.destroy();
          remote.destroy();
          return;
        }
        local.pipe(remote);
        remote.pipe(local);
      }
    );
    const bye = (): void => {
      sockets.delete(local);
      local.destroy();
      remote.destroy();
    };
    local.on("error", bye);
    local.on("close", bye);
    remote.on("error", bye);
    remote.on("close", bye);
  });
  return new Promise((res, rej) => {
    server.once("error", rej);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as net.AddressInfo;
      res({
        port: addr.port,
        close: () => {
          for (const s of sockets) s.destroy();
          server.close();
        },
      });
    });
  });
}
