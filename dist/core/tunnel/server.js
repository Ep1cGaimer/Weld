import * as tls from "node:tls";
import * as net from "node:net";
import { getIdentity } from "../identity.js";
import { peerFingerprints } from "../peers.js";
import { JsonLines } from "../proto.js";
export class ControlServer {
    handlers;
    rpcPort;
    server;
    conns = new Map();
    names = new Map();
    joined = new Set();
    constructor(handlers, rpcPort) {
        this.handlers = handlers;
        this.rpcPort = rpcPort;
    }
    listen(port) {
        const id = getIdentity();
        this.server = tls.createServer({ cert: id.certPem, key: id.keyPem, requestCert: true, rejectUnauthorized: false }, (s) => {
            const fps = peerFingerprints();
            const cert = s.getPeerCertificate();
            if (!cert || !cert.fingerprint256 || !fps.has(cert.fingerprint256)) {
                s.destroy();
                return;
            }
            const jl = new JsonLines((d) => s.write(d), (m) => void this.onMsg(s, m));
            this.conns.set(s, jl);
            s.setEncoding("utf8");
            s.on("data", (d) => jl.feed(d));
            s.on("error", () => { });
            s.on("close", () => {
                const name = this.names.get(s) ?? "peer";
                const wasJoined = this.joined.delete(s);
                this.conns.delete(s);
                this.names.delete(s);
                if (wasJoined)
                    this.handlers.onSessionEnd(name);
            });
        });
        return new Promise((res, rej) => {
            this.server.once("error", rej);
            this.server.listen(port, () => res());
        });
    }
    async onMsg(s, m) {
        const jl = this.conns.get(s);
        if (!jl)
            return;
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
                }
                catch (e) {
                    jl.send({ t: "joined", ok: false, error: e instanceof Error ? e.message : String(e) });
                }
                break;
            case "leave":
                if (this.joined.delete(s))
                    this.handlers.onSessionEnd(this.names.get(s) ?? "peer");
                break;
            default:
                break;
        }
    }
    broadcast(m) {
        for (const jl of this.conns.values())
            jl.send(m);
    }
    close() {
        this.server?.close();
        for (const s of this.conns.keys())
            s.destroy();
    }
}
export function startRelay(relayPort, rpcPort) {
    const id = getIdentity();
    const server = tls.createServer({ cert: id.certPem, key: id.keyPem, requestCert: true, rejectUnauthorized: false }, (s) => {
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
    });
    return new Promise((res, rej) => {
        server.once("error", rej);
        server.listen(relayPort, () => res(relayPort));
    });
}
