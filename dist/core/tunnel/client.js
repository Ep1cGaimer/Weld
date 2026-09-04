import * as tls from "node:tls";
import * as net from "node:net";
import { getIdentity } from "../identity.js";
import { JsonLines } from "../proto.js";
export function connectControl(peer, timeoutMs = 4000) {
    const id = getIdentity();
    return new Promise((res, rej) => {
        let settled = false;
        const finish = (fn) => {
            if (settled)
                return;
            settled = true;
            fn();
        };
        const sock = tls.connect({
            host: peer.host,
            port: peer.controlPort,
            cert: id.certPem,
            key: id.keyPem,
            rejectUnauthorized: false,
        }, () => {
            const cert = sock.getPeerCertificate();
            if (!cert || cert.fingerprint256 !== peer.fingerprint) {
                sock.destroy();
                finish(() => rej(new Error(`certificate mismatch for ${peer.name}`)));
                return;
            }
            const hooks = [];
            const pending = new Set();
            const jl = new JsonLines((d) => sock.write(d), (m) => {
                for (const h of [...hooks])
                    h(m);
                for (const p of [...pending])
                    if (p(m))
                        pending.delete(p);
            });
            sock.setEncoding("utf8");
            sock.on("data", (d) => jl.feed(d));
            let resolveClosed = () => { };
            const closed = new Promise((r) => (resolveClosed = r));
            sock.on("close", () => resolveClosed());
            finish(() => res({
                send: (m) => {
                    if (!sock.destroyed)
                        jl.send(m);
                },
                request: (m, match, ms = 8000) => new Promise((r2, rj2) => {
                    const timer = setTimeout(() => rj2(new Error("request timed out")), ms);
                    pending.add((msg) => {
                        if (!match(msg))
                            return false;
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
            }));
        });
        sock.on("error", (e) => finish(() => rej(e)));
        setTimeout(() => {
            if (!settled) {
                sock.destroy();
                finish(() => rej(new Error(`connection to ${peer.host}:${peer.controlPort} timed out`)));
            }
        }, timeoutMs);
    });
}
export function openRelay(peer) {
    const id = getIdentity();
    const sockets = new Set();
    const server = net.createServer((local) => {
        sockets.add(local);
        const remote = tls.connect({
            host: peer.host,
            port: peer.relayPort,
            cert: id.certPem,
            key: id.keyPem,
            rejectUnauthorized: false,
        }, () => {
            const cert = remote.getPeerCertificate();
            if (!cert || cert.fingerprint256 !== peer.fingerprint) {
                local.destroy();
                remote.destroy();
                return;
            }
            local.pipe(remote);
            remote.pipe(local);
        });
        const bye = () => {
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
            const addr = server.address();
            res({
                port: addr.port,
                close: () => {
                    for (const s of sockets)
                        s.destroy();
                    server.close();
                },
            });
        });
    });
}
