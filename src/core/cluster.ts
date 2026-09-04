import { loadPeers, PeerEntry } from "./peers.js";
import { collectLocal } from "./telemetry.js";
import { connectControl, ControlConn } from "./tunnel/client.js";
import { Telemetry } from "./proto.js";
import { machineName } from "./identity.js";

export interface LivePeer {
  peer: PeerEntry;
  conn: ControlConn;
  telemetry: Telemetry;
  rttMs: number;
}

export interface DeadPeer {
  peer: PeerEntry;
  reason: string;
}

export interface Cluster {
  head: Telemetry;
  live: LivePeer[];
  dead: DeadPeer[];
}

async function probe(peer: PeerEntry, timeoutMs: number): Promise<LivePeer> {
  const head = collectLocal();
  const started = Date.now();
  const conn = await connectControl(peer, timeoutMs);
  const telemetry = (await conn.request(
    { t: "hello", nodeId: head.nodeId, name: machineName(), build: head.build },
    (m) => m.t === "telemetry",
    timeoutMs
  )) as Telemetry & { t: "telemetry" };
  return { peer, conn, telemetry, rttMs: Date.now() - started };
}

export async function gatherCluster(
  exclude: string[] = [],
  timeoutMs = 3500
): Promise<Cluster> {
  const head = collectLocal();
  const peers = loadPeers().filter((p) => !exclude.includes(p.name) && !exclude.includes(p.id));
  const results = await Promise.all(
    peers.map(async (peer) => {
      try {
        return { kind: "live" as const, value: await probe(peer, timeoutMs) };
      } catch (e) {
        return {
          kind: "dead" as const,
          value: { peer, reason: e instanceof Error ? e.message : String(e) },
        };
      }
    })
  );
  return {
    head,
    live: results.filter((r) => r.kind === "live").map((r) => r.value as LivePeer),
    dead: results.filter((r) => r.kind === "dead").map((r) => r.value as DeadPeer),
  };
}

export function closeCluster(cluster: Cluster): void {
  for (const l of cluster.live) l.conn.close();
}
