import { loadPeers } from "./peers.js";
import { collectLocal } from "./telemetry.js";
import { connectControl } from "./tunnel/client.js";
import { machineName } from "./identity.js";
async function probe(peer, timeoutMs) {
    const head = collectLocal();
    const started = Date.now();
    const conn = await connectControl(peer, timeoutMs);
    const telemetry = (await conn.request({ t: "hello", nodeId: head.nodeId, name: machineName(), build: head.build }, (m) => m.t === "telemetry", timeoutMs));
    return { peer, conn, telemetry, rttMs: Date.now() - started };
}
export async function gatherCluster(exclude = [], timeoutMs = 3500) {
    const head = collectLocal();
    const peers = loadPeers().filter((p) => !exclude.includes(p.name) && !exclude.includes(p.id));
    const results = await Promise.all(peers.map(async (peer) => {
        try {
            return { kind: "live", value: await probe(peer, timeoutMs) };
        }
        catch (e) {
            return {
                kind: "dead",
                value: { peer, reason: e instanceof Error ? e.message : String(e) },
            };
        }
    }));
    return {
        head,
        live: results.filter((r) => r.kind === "live").map((r) => r.value),
        dead: results.filter((r) => r.kind === "dead").map((r) => r.value),
    };
}
export function closeCluster(cluster) {
    for (const l of cluster.live)
        l.conn.close();
}
